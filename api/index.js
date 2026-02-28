require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');
const fetch = require('node-fetch');

// Initialize Google Generative AI - Portais Estáveis
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const supabaseUrl = process.env.SUPABASE_URL || 'https://aoejmzgcgvvtyokfvubn.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Route: Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Nutrik.AI Backend is running' });
});

// Route: Chat (STABLE VERSION)
app.post('/api/chat', async (req, res) => {
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem obrigatória' });

        // CONFIGURAÇÃO MESTRA: v1 ESTÁVEL
        const model = "gemini-1.5-flash";
        const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        let contents = [];
        // Instrução de sistema como primeira mensagem para máxima compatibilidade
        const systemInstruction = "Você é o Nutrik.IA. Analise as refeições e informe sempre: ALIMENTOS, GRAMAS ESTIMADAS e MACRONUTRIENTES (Proteínas, Carboidratos, Gorduras e Calorias). Use <strong> apenas em números. Responda de forma direta e técnica.";

        contents.push({ role: "user", parts: [{ text: systemInstruction }] });
        contents.push({ role: "model", parts: [{ text: "Entendido. Sou o Nutrik.IA e estou pronto para analisar sua alimentação com precisão técnica." }] });

        if (history && Array.isArray(history)) {
            let lastRole = null;
            history.slice(-4).forEach(h => {
                const role = (h.role === 'model' || h.role === 'assistant') ? 'model' : 'user';
                if (role !== lastRole) {
                    contents.push({ role, parts: [{ text: h.text || "..." }] });
                    lastRole = role;
                }
            });
        }

        let currentParts = [];
        if (message) currentParts.push({ text: message });
        if (imageBase64) {
            const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                currentParts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
            }
        }

        // Se não houver mensagem mas houver imagem, adiciona um prompt padrão
        if (currentParts.length > 0 && !currentParts.some(p => p.text)) {
            currentParts.unshift({ text: "Analise esta imagem nutricionalmente." });
        }

        contents.push({ role: "user", parts: currentParts });

        const payload = {
            contents,
            generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            console.error("Gemini Error:", data);
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
        if (!email || !userId) return res.status(400).json({ error: 'Email and UserId are required' });
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            client_reference_id: userId,
            line_items: [{
                price_data: {
                    currency: 'brl',
                    product_data: { name: 'Nutrik.IA Premium', description: 'Acesso total e análise de humor.' },
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
        console.error('Stripe Error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
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
    app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
