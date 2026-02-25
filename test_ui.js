const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    page.on('pageerror', error => {
        console.log('PAGE ERROR:', error.message);
    });

    page.on('console', msg => {
        console.log('CONSOLE:', msg.text());
    });

    page.on('requestfailed', request => {
        console.log(`REQUEST FAILED: ${request.url()} - ${request.failure().errorText}`);
    });

    try {
        await page.goto('http://localhost:3000/chat.html', { waitUntil: 'networkidle2' });
        await page.type('#chat-input', 'Teste de mensagem de sistema');
        await page.evaluate(() => {
            // mock auth to bypass redirect if it happens
            window.supabaseClient = { auth: { getSession: () => ({ data: { session: true } }) } };
        });
        await page.click('#send-btn');
        await page.waitForTimeout(3000);
        console.log("Test finished.");
    } catch (e) {
        console.error('Run Error:', e.message);
    }

    await browser.close();
})();
