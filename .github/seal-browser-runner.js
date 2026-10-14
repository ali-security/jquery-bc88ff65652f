/*
 * Seal fork-CI driver: runs the jQuery QUnit suite (test/index.html) in
 * headless Chrome via puppeteer-core and reports results on stdout.
 * Lives under .github/ so the project's jshint (test/**) never lints it and
 * it is never part of the published package.
 *
 * Usage: node .github/seal-browser-runner.js <url>
 *   CHROME_PATH       Chrome/Chromium executable (required)
 *   SEAL_MODULES      optional comma-separated QUnit module names; each one
 *                     runs in its own fresh browser via `<url>&module=<name>`
 *                     (how upstream's TestSwarm job ran the suite). Unset:
 *                     one page load runs every module.
 *   SEAL_TEST_FILTER  optional QUnit `filter` (substring of "module: test")
 *   SEAL_SKIP_TESTS   optional "||"-separated list of exact "module: test"
 *                     names that are not registered (printed as SKIPPED)
 *
 * Exit: 0 all green, 1 failures, 2 timeout / a page never finished / no
 * tests ran.
 */
"use strict";

const puppeteer = require( "puppeteer-core" );

const OVERALL_TIMEOUT_MS = 40 * 60 * 1000;
const HEARTBEAT_MS = 120 * 1000;
const PREFIX = "__SEAL__";

let url = process.argv[ 2 ];
const filter = process.env.SEAL_TEST_FILTER || "";
const skipList = ( process.env.SEAL_SKIP_TESTS || "" )
	.split( "||" )
	.map( ( s ) => s.trim() )
	.filter( ( s ) => s.length > 0 );
const moduleList = ( process.env.SEAL_MODULES || "" )
	.split( "," )
	.map( ( s ) => s.trim() )
	.filter( ( s ) => s.length > 0 );

if ( !url ) {
	console.error( "usage: node .github/seal-browser-runner.js <url>" );
	process.exit( 2 );
}
if ( !process.env.CHROME_PATH ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}
if ( filter ) {
	url += ( url.indexOf( "?" ) >= 0 ? "&" : "?" ) + "filter=" + encodeURIComponent( filter );
}

/*
 * Runs in every frame before any page script. Only the top frame is hooked:
 * the suite spawns many iframes that reach QUnit through `parent`.
 * Serialized into the page, so it must be self-contained.
 */
function pageHook( skipNames ) {

	// Snapshot natives up front: tests may replace window.JSON (the "basic"
	// URL option nulls it) or console, and the reporter must keep working.
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeLog = window.console.log,
		nativeConsole = window.console;

	if ( window.top !== window ) {
		return;
	}

	var skip = {},
		hooked = false,
		qunitRef, i;

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" +
				nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type, data: { error: "unserializable payload: " + e }
				} ) );
			} catch ( e2 ) {}
		}
	}

	function dump( value ) {
		var out, dumper;
		try {
			dumper = qunitRef && ( qunitRef.dump || qunitRef.jsDump );
			out = dumper ? dumper.parse( value ) : String( value );
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	// QUnit 1.17.1 assigns window.QUnit last, once config, the logging
	// callback registrars and the window.test/asyncTest globals all exist.
	function hookQUnit( q ) {
		if ( hooked || !q || !q.config ) {
			return;
		}
		hooked = true;

		q.config.reorder = false;

		// Skip support: every registration path ends in QUnit.test (window.test
		// is a copy taken at export time and replaced below; QUnit.asyncTest
		// and testinit.js's ajaxTest/testIframe helpers call QUnit.test).
		var origTest = q.test;
		var wrappedTest = function( testName ) {
			var mod = q.config.currentModule,
				modName = mod && mod.name,
				key = ( modName ? modName + ": " : "" ) + testName;
			if ( skip[ key ] ) {
				emit( "skip", { name: key } );
				return;
			}
			return origTest.apply( this, arguments );
		};
		q.test = wrappedTest;
		window.test = wrappedTest;

		q.begin( function() {
			emit( "begin", {} );
		} );
		q.moduleStart( function( d ) {
			emit( "moduleStart", { name: d.name } );
		} );
		q.testStart( function( d ) {
			emit( "testStart", { name: d.name, module: d.module } );
		} );
		q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			} );
		} );
		q.testDone( function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} );
		q.done( function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	} );
}

function pad( s, n ) {
	return String( s ).padEnd( n );
}

function withParam( base, key, value ) {
	return base + ( base.indexOf( "?" ) >= 0 ? "&" : "?" ) + key + "=" + encodeURIComponent( value );
}

// Aggregated results across every page load.
const modules = new Map();
// A skipped test is seen once per page load (every page registers every
// module's tests before QUnit's module filter applies), so keep a set.
const skippedTests = new Set();
const failedNames = [];
const pageProblems = [];
let failedTests = 0;
let passedTests = 0;
let assertPassed = 0;
let assertFailed = 0;
let runtime = 0;

function moduleStats( name ) {
	if ( !modules.has( name ) ) {
		modules.set( name, { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 } );
	}
	return modules.get( name );
}

function printSummary() {
	const totalTests = passedTests + failedTests;
	console.log( "" );
	console.log( "==================== SUMMARY ====================" );
	if ( skippedTests.size ) {
		console.log( "Skipped (not registered): " + skippedTests.size );
		skippedTests.forEach( ( n ) => console.log( "  SKIPPED: " + n ) );
	}
	skipList.filter( ( n ) => !skippedTests.has( n ) ).forEach( ( n ) => {
		console.log( "WARNING: SEAL_SKIP_TESTS entry matched no test: " + n );
	} );
	console.log( pad( "module", 28 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
		pad( "assertions", 12 ) + "failed" );
	for ( const [ name, m ] of modules ) {
		console.log( pad( name, 28 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
			pad( m.assertions, 12 ) + m.failedAssertions );
	}
	if ( failedNames.length ) {
		console.log( "Failed tests:" );
		failedNames.forEach( ( n ) => console.log( "  FAILED: " + n ) );
	}
	if ( pageProblems.length ) {
		console.log( "Pages that did not finish:" );
		pageProblems.forEach( ( n ) => console.log( "  " + n ) );
	}
	console.log( "Tests: " + passedTests + " passed, " + failedTests + " failed, " +
		totalTests + " total; Assertions: " + assertPassed + " passed, " + assertFailed +
		" failed, " + ( assertPassed + assertFailed ) + " total; runtime " + runtime + " ms" );
}

/*
 * Loads one suite page in a fresh browser and resolves once QUnit's done
 * fires: { ok: true } or { ok: false, reason } (timeout, crash, no done).
 */
function runPage( pageUrl ) {
	return new Promise( ( resolve ) => {
		let browser = null;
		let settled = false;
		let currentTest = null;
		let lastProgress = Date.now();
		let lastHeartbeat = Date.now();
		let heartbeatTimer = null;
		let overallTimer = null;

		function settle( result ) {
			if ( settled ) {
				return;
			}
			settled = true;
			clearInterval( heartbeatTimer );
			clearTimeout( overallTimer );
			const closing = browser ? browser.close() : Promise.resolve();

			// Do not let a hung browser.close() keep us waiting.
			const guard = setTimeout( () => resolve( result ), 15000 );
			closing.catch( () => {} ).then( () => {
				clearTimeout( guard );
				resolve( result );
			} );
		}

		function onEvent( ev ) {
			const d = ev.data || {};
			let m;
			switch ( ev.type ) {
			case "begin":
				console.log( "QUnit begin" );
				break;
			case "moduleStart":
				console.log( "MODULE " + d.name );
				break;
			case "testStart":
				currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
				break;
			case "log":
				console.log( "    assertion failed: " + d.message );
				console.log( "      expected: " + d.expected );
				console.log( "      actual:   " + d.actual );
				if ( d.source ) {
					console.log( "      source:   " +
						String( d.source ).split( "\n" ).join( "\n                " ) );
				}
				break;
			case "testDone":
				lastProgress = Date.now();
				lastHeartbeat = lastProgress;
				currentTest = null;
				m = moduleStats( d.module || "(no module)" );
				m.tests++;
				m.assertions += d.total;
				m.failedAssertions += d.failed;
				if ( d.failed > 0 ) {
					m.failedTests++;
					failedTests++;
					failedNames.push( d.module + ": " + d.name );
				} else {
					passedTests++;
				}
				console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " + d.name +
					" (" + d.passed + "/" + d.total + ")" );
				break;
			case "skip":
				if ( !skippedTests.has( d.name ) ) {
					skippedTests.add( d.name );
					console.log( "SKIPPED: " + d.name );
				}
				break;
			case "done":
				assertPassed += d.passed;
				assertFailed += d.failed;
				runtime += d.runtime;
				console.log( "QUnit done: " + d.passed + "/" + d.total + " assertions passed, " +
					d.failed + " failed, " + d.runtime + " ms" );
				settle( { ok: true } );
				break;
			default:
				console.log( "unknown event: " + JSON.stringify( ev ) );
			}
		}

		overallTimer = setTimeout( () => {
			settle( {
				ok: false,
				reason: "TIMEOUT: page did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
					" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" )
			} );
		}, OVERALL_TIMEOUT_MS );

		heartbeatTimer = setInterval( () => {
			const now = Date.now();
			if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
				lastHeartbeat = now;
				console.log( "HEARTBEAT: no test completed in " +
					Math.round( ( now - lastProgress ) / 1000 ) + "s; running: " +
					( currentTest || "(none / between tests)" ) );
			}
		}, 5000 );

		console.log( "URL: " + pageUrl );

		( async() => {
			browser = await puppeteer.launch( {
				executablePath: process.env.CHROME_PATH,
				headless: true,
				args: [ "--no-sandbox", "--headless=new", "--disable-gpu",
					"--force-device-scale-factor=1" ]
			} );
			browser.on( "disconnected", () => {
				settle( { ok: false, reason: "ERROR: browser disconnected before QUnit done" } );
			} );
			const page = await browser.newPage();
			page.on( "console", ( msg ) => {
				const text = msg.text();
				if ( text.indexOf( PREFIX ) !== 0 ) {
					return;
				}
				let ev;
				try {
					ev = JSON.parse( text.slice( PREFIX.length ) );
				} catch ( e ) {
					console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
					return;
				}
				onEvent( ev );
			} );
			page.on( "pageerror", ( err ) => {
				console.log( "PAGE ERROR: " + ( err && err.message ? err.message : String( err ) ) );
			} );
			page.on( "dialog", ( dialog ) => {
				console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
				dialog.dismiss().catch( () => {} );
			} );
			page.on( "error", ( err ) => {
				settle( {
					ok: false,
					reason: "ERROR: page crashed: " + ( err && err.message ? err.message : String( err ) )
				} );
			} );
			await page.evaluateOnNewDocument( pageHook, skipList );
			await page.goto( pageUrl, { waitUntil: "load", timeout: 120000 } );
			console.log( "page loaded; waiting for QUnit done" );
		} )().catch( ( err ) => {
			settle( { ok: false, reason: "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) } );
		} );
	} );
}

async function main() {
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );
	}

	// One fresh page per module (as upstream's TestSwarm job does) keeps a
	// module's leftovers from leaking into later modules' assertions.
	const pages = moduleList.length ?
		moduleList.map( ( name ) => ( { label: name, url: withParam( url, "module", name ) } ) ) :
		[ { label: "(all)", url: url } ];

	for ( const p of pages ) {
		console.log( "" );
		console.log( "=== page: " + p.label + " ===" );
		const result = await runPage( p.url );
		if ( !result.ok ) {
			console.log( result.reason );
			pageProblems.push( p.label + ": " + result.reason );
		}
	}

	printSummary();
	if ( pageProblems.length ) {
		process.exit( 2 );
	}
	if ( passedTests + failedTests === 0 ) {
		console.log( "ERROR: no tests ran" );
		process.exit( 2 );
	}
	process.exit( failedTests === 0 && assertFailed === 0 ? 0 : 1 );
}

main();
