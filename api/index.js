require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');

// Initialize Google Generative AI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const supabaseUrl = process.env.SUPABASE_URL || 'https://aoejmzgcgvvtyokfvubn.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Middleware para validar chave de API em endpoints críticos
const validateApiKey = (req, res, next) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: "GEMINI_API_KEY não configurada no servidor." });
    }
    next();
};

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// NOVO: Endpoint para listar modelos disponíveis (Descoberta)
app.get('/api/gemini-models', validateApiKey, async (req, res) => {
    try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models`, {
            headers: { "x-goog-api-key": GEMINI_API_KEY },
        });
        const data = await r.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route: Chat (PATCHED BY USER SUGGESTION)
app.post('/api/chat', validateApiKey, async (req, res) => {
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem obrigatória' });

        // CONFIGURAÇÃO MESTRA: use v1beta (é o endpoint do generateContent na doc)
        const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        let contents = [];

        // Histórico limitado
        if (history && Array.isArray(history)) {
            let lastRole = null;
            history.slice(-6).forEach(h => {
                const role = (h.role === 'model' || h.role === 'assistant') ? 'model' : 'user';
                if (role !== lastRole) {
                    contents.push({ role, parts: [{ text: h.text || "..." }] });
                    lastRole = role;
                }
            });
            if (lastRole === 'user' && !message && !imageBase64) contents.pop();
        }

        let currentParts = [];
        if (message) currentParts.push({ text: message });

        // Tratamento flexível de imagem (com ou sem prefixo)
        if (imageBase64) {
            const hasDataUri = imageBase64.startsWith("data:");
            if (hasDataUri) {
                const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
                if (matches?.[1] && matches?.[2]) {
                    currentParts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
                }
            } else {
                // assume base64 seco (fallback jpeg)
                currentParts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
            }

            // Se apenas imagem, garante um prompt
            if (!message) {
                currentParts.unshift({ text: "Analise esta imagem nutricionalmente: alimentos, gramas estimadas e macronutrientes." });
            }
        }

        contents.push({ role: "user", parts: currentParts });

        const payload = {
            contents,
            systemInstruction: {
                parts: [{ text: "Você é o Nutrik.IA. Analise as refeições e informe sempre: ALIMENTOS, GRAMAS ESTIMADAS e MACRONUTRIENTES (P, C, G e Calorias). Use <strong> apenas em números. Responda direto, sem introduções." }]
            },
            generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            console.error("Gemini Error Details:", data);
            throw new Error(data.error?.message || 'Erro Google API');
        }

        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Desculpe, não consegui analisar agora.";
        res.json({ reply });

    } catch (error) {
        console.error('Chat Error:', error);
        res.status(500).json({ error: 'Erro na IA', details: error.message });
    }
});

// Route: Stripe Checkout
app.post('/api/checkout-session', async (req, res) => {
    try {
        const { email, userId } = req.body;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            client_reference_id: userId,
            line_items: [{
                price_data: {
                    currency: 'brl',
                    product_data: { name: 'Nutrik.IA Premium' },
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
        res.status(500).json({ error: error.message });
    }
});

// Route: Stripe Webhook
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        await supabaseAdmin.from('profiles').upsert({
            id: session.client_reference_id,
            email: session.customer_details?.email,
            plan: 'premium',
            credits: 9999,
            updated_at: new Date().toISOString()
        });
    }
    res.status(200).end();
});

if (require.main === module) {
    app.listen(port, () => console.log(`Server port ${port}`));
}

module.exports = app;
