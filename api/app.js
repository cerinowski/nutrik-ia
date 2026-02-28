require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');
// Initialize Google Generative AI - Usando Fetch Direto
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Supabase Admin Client (Usado no Webhook do Stripe)
const supabaseUrl = process.env.SUPABASE_URL || 'https://aoejmzgcgvvtyokfvubn.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
const port = process.env.PORT || 3000;

const supabaseKey = process.env.SUPABASE_KEY || 'dummy_key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Webhook endpoint needs raw body for Stripe signature verification
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const payload = req.body;
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        if (endpointSecret) {
            event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
        } else {
            event = JSON.parse(payload.toString());
            console.warn('⚠️ Webhook secret not set. Skipping signature verification.');
        }
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const customerEmail = session.customer_details?.email;
        if (userId) {
            try {
                await supabaseAdmin.from('profiles').upsert({
                    id: userId,
                    email: customerEmail,
                    plan: 'premium',
                    credits: 9999,
                    updated_at: new Date().toISOString()
                });
            } catch (dbError) {
                console.error('Exceção ao atualizar Supabase:', dbError);
            }
        }
    }
    res.status(200).end();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

if (process.env.NODE_ENV !== 'production') {
    app.use(express.static(path.join(__dirname, '../')));
}

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Nutrik.AI Backend is running' });
});

// Chat Endpoint - Optimized for complete responses and 60s timeout
app.post('/api/chat', async (req, res) => {
    const startTime = Date.now();
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem obrigatória' });

        const model = "gemini-1.5-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${GEMINI_API_KEY}`;

        let contents = [];
        if (history && Array.isArray(history) && history.length > 0) {
            let lastRole = null;
            history.slice(-6).forEach(h => {
                const role = h.role === 'model' || h.role === 'assistant' ? 'model' : 'user';
                if (role !== lastRole) {
                    contents.push({ role, parts: [{ text: h.text || "..." }] });
                    lastRole = role;
                }
            });
            if (lastRole === 'user') contents.pop();
        }

        let currentParts = [];
        if (message) currentParts.push({ text: message });
        if (imageBase64) {
            const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                if (!message) currentParts.push({ text: "Analise esta refeição detalhadamente: alimentos, gramas estimadas e macronutrientes (P, C, G e Calorias). Use <strong> em números." });
                currentParts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
            }
        }
        contents.push({ role: "user", parts: currentParts });

        const payload = {
            contents,
            system_instruction: { parts: [{ text: "Você é o Nutrik.IA. Informe sempre: alimentos, gramas estimadas e Macronutrientes. Use <strong> apenas em números. Seja amigável e técnico. NUNCA interrompa o raciocínio." }] },
            generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || 'Erro Google API');
        }

        // Set Headers for streaming
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Em Node.js com node-fetch v2, response.body é um Readable Stream do Node
        response.body.on('data', (chunk) => {
            const text = chunk.toString();
            // Busca o campo "text" dentro do chunk JSON do Google
            const matches = text.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
            if (matches) {
                matches.forEach(m => {
                    const t = m.match(/"text":\s*"(.*)"/);
                    if (t && t[1]) {
                        try {
                            const cleanText = JSON.parse(`"${t[1]}"`);
                            res.write(cleanText);
                        } catch (e) { }
                    }
                });
            }
        });

        response.body.on('end', () => {
            res.end();
        });

        response.body.on('error', (err) => {
            console.error('Streaming Response Error:', err);
            if (!res.headersSent) res.status(500).send("Erro no stream.");
            else res.end();
        });

    } catch (error) {
        console.error('Chat Critical Error:', error);
        res.status(500).json({ error: 'Erro técnico de IA.', details: error.message });
    }
});

app.post('/api/checkout-session', async (req, res) => {
    try {
        const { email, userId } = req.body;
        if (!email || !userId) return res.status(400).json({ error: 'Email and UserId are required' });
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            client_reference_id: userId,
            line_items: [{
                price_data: {
                    currency: 'brl',
                    product_data: {
                        name: 'Nutrik.IA Premium',
                        description: 'Acesso total, passes livres e análise de humor.',
                    },
                    unit_amount: 5700,
                    recurring: { interval: 'month' }
                },
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${req.protocol}://${req.get('host')}/chat.html?success=true`,
            cancel_url: `${req.protocol}://${req.get('host')}/plans.html?canceled=true`,
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

if (require.main === module) {
    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

module.exports = app;
