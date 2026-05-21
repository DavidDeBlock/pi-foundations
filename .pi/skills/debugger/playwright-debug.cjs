const { chromium } = require('playwright');
const fs = require('fs');

async function runDebugger() {
    const args = JSON.parse(process.argv[2]);
    
    // Launch browser
    const browser = await chromium.launch({
        headless: true,
        timeout: args.timeout || 30000
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Collect data
    const consoleLogs = [];
    const errors = [];
    const networkRequests = [];
    
    // Console event listener
    page.on('console', msg => {
        consoleLogs.push({
            type: msg.type(),
            text: msg.text(),
            url: msg.location().url || '',
            lineNumber: msg.location().lineNumber || 0,
            columnNumber: msg.location().columnNumber || 0,
            timestamp: new Date().toISOString()
        });
    });
    
    // Page error listener
    page.on('pageerror', error => {
        errors.push({
            message: error.message,
            stackTrace: error.stack || '',
            fileName: error.fileName || '',
            lineNumber: error.lineNumber || 0,
            columnNumber: error.columnNumber || 0,
            timestamp: new Date().toISOString()
        });
    });
    
    // Network request listener
    page.on('request', request => {
        const startTime = Date.now();
        
        request.once('response', async response => {
            networkRequests.push({
                url: request.url(),
                method: request.method(),
                status: response.status(),
                statusText: response.statusText(),
                responseTime: Date.now() - startTime,
                size: parseInt(response.headers()['content-length'] || '0'),
                type: request.resourceType(),
                timestamp: new Date().toISOString()
            });
        });
        
        request.once('fail', error => {
            networkRequests.push({
                url: request.url(),
                method: request.method(),
                status: 0,
                error: error.message,
                type: request.resourceType(),
                timestamp: new Date().toISOString()
            });
        });
    });
    
    // Navigate to page
    try {
        await page.goto(args.url, {
            waitUntil: 'networkidle',
            timeout: args.timeout || 30000
        });
        
        // Wait a bit for any late logs/errors
        await new Promise(resolve => setTimeout(resolve, 2000));
        
    } catch (error) {
        console.error('Navigation error:', error.message);
    }
    
    // Perform action based on command
    if (args.action === 'query' && args.selector) {
        const element = await page.$(args.selector);
        if (element) {
            if (args.attribute) {
                console.log(JSON.stringify({
                    found: true,
                    type: 'attribute',
                    selector: args.selector,
                    attribute: args.attribute,
                    value: await element.getAttribute(args.attribute),
                    timestamp: new Date().toISOString()
                }));
            } else {
                console.log(JSON.stringify({
                    found: true,
                    type: 'element',
                    selector: args.selector,
                    textContent: await element.textContent(),
                    innerHTML: await element.innerHTML(),
                    timestamp: new Date().toISOString()
                }));
            }
        } else {
            console.log(JSON.stringify({
                found: false,
                type: 'element',
                selector: args.selector,
                timestamp: new Date().toISOString()
            }));
        }
    } else if (args.action === 'exists' && args.selector) {
        const element = await page.$(args.selector);
        console.log(JSON.stringify({
            exists: !!element,
            selector: args.selector,
            timestamp: new Date().toISOString()
        }));
    } else if (args.action === 'eval' && args.script) {
        try {
            const result = await page.evaluate(args.script);
            console.log(JSON.stringify({
                type: 'eval',
                script: args.script,
                result: result,
                timestamp: new Date().toISOString()
            }));
        } catch (error) {
            console.log(JSON.stringify({
                type: 'eval_error',
                script: args.script,
                error: error.message,
                timestamp: new Date().toISOString()
            }));
        }
    } else if (args.action === 'screenshot' && args.selector) {
        const element = await page.$(args.selector);
        if (element) {
            await element.screenshot({ path: args.output || '/tmp/screenshot.png' });
            console.log(JSON.stringify({
                type: 'screenshot',
                success: true,
                output: args.output || '/tmp/screenshot.png',
                timestamp: new Date().toISOString()
            }));
        } else {
            console.log(JSON.stringify({
                type: 'screenshot_error',
                success: false,
                error: 'Element not found',
                selector: args.selector,
                timestamp: new Date().toISOString()
            }));
        }
    } else if (args.action === 'screenshot' && !args.selector) {
        await page.screenshot({ path: args.output || '/tmp/screenshot.png', fullPage: true });
        console.log(JSON.stringify({
            type: 'screenshot',
            success: true,
            output: args.output || '/tmp/screenshot.png',
            timestamp: new Date().toISOString()
        }));
    } else if (args.action === 'trace') {
        const tracePath = args.output || '/tmp/trace.zip';
        await page.tracing.start({ screenshots: true, snapshots: true, sources: true });
        
        // Wait for activity
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        await page.tracing.stop({ path: tracePath });
        console.log(JSON.stringify({
            type: 'trace',
            success: true,
            output: tracePath,
            timestamp: new Date().toISOString()
        }));
    } else if (args.action === 'pause' && args.selector) {
        const element = await page.$(args.selector);
        if (element) {
            console.log(JSON.stringify({
                type: 'paused',
                selector: args.selector,
                message: 'Paused at element. Press Ctrl+C to continue.',
                timestamp: new Date().toISOString()
            }));
            
            // Wait for manual intervention (max 60 seconds)
            await new Promise(resolve => setTimeout(resolve, 60000));
        } else {
            console.log(JSON.stringify({
                type: 'pause_error',
                selector: args.selector,
                error: 'Element not found',
                timestamp: new Date().toISOString()
            }));
        }
    }
    
    // Output collected data based on action
    if (args.action === 'logs' || !args.action) {
        let filteredLogs = consoleLogs;
        
        if (args.type && args.type !== 'all') {
            filteredLogs = consoleLogs.filter(log => log.type === args.type);
        }
        
        const output = {
            summary: {
                total: consoleLogs.length,
                byType: {
                    info: consoleLogs.filter(l => l.type === 'info').length,
                    warning: consoleLogs.filter(l => l.type === 'warning').length,
                    error: consoleLogs.filter(l => l.type === 'error').length,
                    log: consoleLogs.filter(l => l.type === 'log').length
                }
            },
            logs: filteredLogs
        };
        
        if (args.output) {
            fs.writeFileSync(args.output, JSON.stringify(output, null, 2));
            console.log(JSON.stringify({ output_file: args.output }));
        } else {
            console.log(JSON.stringify(output));
        }
    }
    
    if (args.action === 'errors' || !args.action) {
        const output = {
            summary: {
                total: errors.length,
                byType: {
                    javascript: errors.filter(e => !e.isRejection).length,
                    rejection: errors.filter(e => e.isRejection).length
                }
            },
            errors: errors
        };
        
        if (args.output) {
            fs.writeFileSync(args.output, JSON.stringify(output, null, 2));
            console.log(JSON.stringify({ output_file: args.output }));
        } else {
            console.log(JSON.stringify(output));
        }
    }
    
    if (args.action === 'network' || !args.action) {
        let filteredRequests = networkRequests;
        
        if (args.type && args.type !== 'all') {
            filteredRequests = networkRequests.filter(req => req.type === args.type);
        }
        
        const output = {
            summary: {
                total: networkRequests.length,
                failed: networkRequests.filter(r => r.status === 0 || r.error).length,
                byType: {}
            },
            requests: filteredRequests
        };
        
        // Count by type
        networkRequests.forEach(req => {
            output.summary.byType[req.type] = (output.summary.byType[req.type] || 0) + 1;
        });
        
        if (args.output) {
            fs.writeFileSync(args.output, JSON.stringify(output, null, 2));
            console.log(JSON.stringify({ output_file: args.output }));
        } else {
            console.log(JSON.stringify(output));
        }
    }
    
    await browser.close();
}

runDebugger().catch(err => {
    console.error('Debugger error:', err.message);
    process.exit(1);
});
