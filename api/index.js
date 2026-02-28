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

// Middleware para validar chave de API
const validateApiKey = (req, res, next) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: "GEMINI_API_KEY não configurada no servidor." });
    }
    next();
};

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ✅ NOVO: Endpoint de Debug sugerido pelo usuário
app.get('/api/debug-gemini-models', async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY ausente" });

        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': GEMINI_API_KEY }
        });

        const data = await r.json();
        res.status(r.ok ? 200 : r.status).json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ✅ RESTRUTURAÇÃO FINAL COM FALLBACK EM CASCATA (Sugestão do Usuário)
app.post('/api/chat', validateApiKey, async (req, res) => {
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem obrigatória' });

        // 💡 SIMULAÇÃO DE OPT-IN DE SYSTEM PROMPT (Contents-Only REST compatible)
        let contents = [
            {
                role: "user",
                parts: [{ text: "Você é o Nutrik.IA. Analise alimentos e sempre retorne: ALIMENTOS, GRAMAS ESTIMADAS e MACRONUTRIENTES (P, C, G e Calorias). Use <strong> em números. Responda direto, sem introduções." }]
            },
            {
                role: "model",
                parts: [{ text: "Entendido. Sou o Nutrik.IA e estou pronto para analisar sua alimentação com precisão técnica." }]
            }
        ];

        // Histórico
        if (history && Array.isArray(history)) {
            let lastRole = null;
            history.slice(-6).forEach(h => {
                const role = (h.role === 'model' || h.role === 'assistant') ? 'model' : 'user';
                if (role !== lastRole) {
                    contents.push({ role, parts: [{ text: h.text || "..." }] });
                    lastRole = role;
                }
            });
            if (lastRole === 'user' && (message || imageBase64)) contents.pop();
        }

        let currentParts = [];
        if (message) currentParts.push({ text: message });

        // Tratamento flexível de imagem (URI vs Raw)
        if (imageBase64) {
            const hasDataUri = imageBase64.startsWith("data:");
            if (hasDataUri) {
                const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
                if (matches?.[1] && matches?.[2]) {
                    currentParts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
                }
            } else {
                currentParts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
            }
            if (!message) {
                currentParts.unshift({ text: "Analise esta imagem nutricionalmente: alimentos, gramas estimadas e macronutrientes." });
            }
        }

        contents.push({ role: "user", parts: currentParts });

        const payload = {
            contents,
            generationConfig: { maxOutputTokens: 2048, temperature: 0.2 }
        };

        // ✅ TENTATIVA EM CASCATA (Para nunca mais travar)
        const candidateModels = [
            process.env.GEMINI_MODEL,
            "gemini-2.0-flash",
            "gemini-1.5-flash-latest",
            "gemini-1.5-flash",
            "gemini-pro"
        ].filter(Boolean);

        let lastErr = null;
        let responseData = null;

        for (const modelName of candidateModels) {
            const cleanModel = modelName.replace('models/', '');
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent`;

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': GEMINI_API_KEY
                    },
                    body: JSON.stringify(payload)
                });

                responseData = await response.json();

                if (response.ok) {
                    lastErr = null;
                    break;
                }
                lastErr = responseData?.error?.message || `Falha com modelo ${cleanModel}`;
            } catch (fetchErr) {
                lastErr = fetchErr.message;
            }
        }

        if (lastErr) {
            console.error("Gemini Cascade Failure:", lastErr, responseData);
            throw new Error(lastErr);
        }

        // ✅ LEITURA ROBUSTA: Junta todas as partes da resposta
        let reply = "Não consegui processar a análise.";
        if (responseData.candidates?.length && responseData.candidates[0].content?.parts) {
            const parts = responseData.candidates[0].content.parts;
            reply = parts.map(p => p.text || "").join("\n");
        }

        res.json({ reply });

    } catch (error) {
        console.error('Critical Chat Error:', error);
        res.status(500).json({ error: 'Erro técnico de IA', details: error.message });
    }
});

// Stripe Checkout
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

// Stripe Webhook
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
