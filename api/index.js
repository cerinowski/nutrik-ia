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

// ✅ REQUISITO 2: Debug Bruto (Raw Text) para diagnosticar permissões
app.get('/api/debug-list-models', async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY ausente" });

        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': GEMINI_API_KEY }
        });

        const text = await r.text(); // <- text, pra não quebrar se não for JSON
        res.status(r.status).send(text);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint antigo (mantido para compatibilidade interna)
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

// ✅ CHAT COM CASCATA (v1beta por padrão)
app.post('/api/chat', validateApiKey, async (req, res) => {
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem obrigatória' });

        let contents = [
            {
                role: "user",
                parts: [{ text: "Você é o Nutrik.IA, o parceiro de saúde e amigo de jornada do usuário. Seja acolhedor, empático e muito motivador. Ao analisar alimentos ou planos, você DEVE detalhar e descrever explicitamente no seu texto quais foram os alimentos identificados, suas gramas estimadas e a quantidade de cada MACRONUTRIENTE (Proteína, Carboidrato, Gordura) e CALORIAS usando <strong> nos números para o usuário ler. Fale como um mentor amigável. PRIORIZE a descrição/legenda enviada pelo usuário (ex: 'Almoço', 'Jantar') como o campo 'description' no JSON. Depois de todo o seu texto explicativo listando os macros para o usuário, você DEVE SEMPRE terminar sua resposta com um bloco JSON no formato exato: ```json {\"calories\": 0, \"protein\": 0, \"carbs\": 0, \"fat\": 0, \"description\": \"nome do prato ou legenda\"} ```" }]
            },
            {
                role: "model",
                parts: [{ text: "Com certeza! Sou o Nutrik.IA. Vou detalhar todos os macronutrientes na minha resposta de texto para você ler facilmente e depois inserirei o JSON no final para organizar seu diário nutricional. Vamos lá!" }]
            }
        ];


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
            generationConfig: { maxOutputTokens: 8192, temperature: 0.2 }
        };

        // ✅ MEGA CASCATA ANTI-COTA PURIFICADA (Modelos extraídos Vivos via ListModels da API Key atual)
        // Ocultado do usuário: A Google extirpou todos os modelos legados "1.5" das novas chaves.
        // Array contendo EXCLUSIVAMENTE modelos que a Chave do Usuário atual enxerga.
        const candidateModels = [
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite", // Fallback Econômico Super Leve 2.5
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite", // Fallback Econômico Super Leve 2.0
            "gemini-flash-latest",
            "gemini-pro-latest"
        ].filter(Boolean);

        let lastErr = null;
        let responseData = null;
        let response = null;

        for (const model of candidateModels) {
            const cleanModel = model.replace('models/', '');
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent`;

            try {
                response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": GEMINI_API_KEY,
                    },
                    body: JSON.stringify(payload),
                });

                responseData = await response.json();

                if (response.ok) {
                    lastErr = null;
                    break; // Sucesso com esse modelo, para aqui e segue em frente
                }

                lastErr = responseData?.error?.message || `Erro no ${cleanModel} (${response.status})`;
                console.warn(`[ANTI-COTA] Modelo ${cleanModel} bloqueado ou falhou. Tentando o próximo modelo na fração de segundo...`, lastErr);

                // Em caso de erro 429 (Cota) ou 503, cai imediatamente para o próximo modelo sem Delay. 
                // Evita estourar os 10 segundos gratuitos da Vercel.

            } catch (err) {
                lastErr = err.message;
                console.warn(`[ANTI-COTA] Problema de fetch no ${cleanModel}:`, lastErr);
            }
        }

        if (lastErr) {
            console.error("Gemini Multi-Cascade Failed Integrally:", lastErr, responseData);
            throw new Error(lastErr);
        }

        let reply = "Não consegui processar a análise.";
        if (responseData.candidates?.length && responseData.candidates[0].content?.parts) {
            const parts = responseData.candidates[0].content.parts;
            reply = parts.map(p => p.text || "").join("\n");
        }

        // ✅ Persistência de Dados (Robusta e Flexível)
        let rawJson = null;
        const jsonBlockMatch = reply.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

        if (jsonBlockMatch && jsonBlockMatch[1]) {
            rawJson = jsonBlockMatch[1].trim();
            reply = reply.replace(jsonBlockMatch[0], "").trim(); // Remove da mensagem mostrada
        } else {
            // Tenta encontrar um objeto JSON nu, caso a IA não use markdown
            const fallbackMatch = reply.match(/\{[\s\S]+\}/);
            if (fallbackMatch) {
                rawJson = fallbackMatch[0].trim();
                reply = reply.replace(fallbackMatch[0], "").trim();
            }
        }

        let nutritionData = null;
        if (rawJson) {
            try {
                const parsed = JSON.parse(rawJson);

                // Normalizar chaves para minúsculo e suportar PT/EN
                nutritionData = {};
                for (let key in parsed) {
                    nutritionData[key.toLowerCase()] = parsed[key];
                }

                const userId = req.body.userId || req.headers['x-user-id'];
                console.log(`[MEAL LOG] Usuário: ${userId}, Dados Extraídos:`, nutritionData);

                if (userId && (nutritionData.calories || nutritionData.calorias || nutritionData.kcal) > 0) {
                    const safeRound = (val) => {
                        if (!val) return 0;
                        const num = parseFloat(String(val).replace(',', '.')); // Lida com vírgulas BR
                        return isNaN(num) ? 0 : Math.round(num);
                    };

                    const calories = safeRound(nutritionData.calories || nutritionData.calorias || nutritionData.kcal);
                    const protein = safeRound(nutritionData.protein || nutritionData.proteina);
                    const carbs = safeRound(nutritionData.carbs || nutritionData.carboidratos);
                    const fat = safeRound(nutritionData.fat || nutritionData.gordura);
                    const finalDesc = nutritionData.description || nutritionData.descricao || message || "Refeição analisada";

                    console.log(`[DATABASE] Iniciando inserção ADMIN (Ignora RLS) para ${userId}: ${finalDesc} (${calories}kcal)`);

                    const { data: insertData, error: insertError } = await supabaseAdmin.from('meals').insert({
                        user_id: userId,
                        description: finalDesc,
                        calories,
                        protein,
                        carbs,
                        fat,
                        image_url: imageBase64 ? "base64_stored" : null
                    }).select();

                    if (insertError) {
                        console.error("[DATABASE ERROR] Falha ao inserir refeição admin:", insertError);
                        nutritionData._admin_saved = false;
                        nutritionData._admin_error = insertError;
                    } else {
                        console.log("[DATABASE SUCCESS] Refeição inserida com ADMIN ID:", insertData?.[0]?.id);
                        nutritionData._admin_saved = true;
                    }
                } else {
                    console.warn("[MEAL LOG] Ignorando salvamento: userId ausente ou calorias <= 0");
                }

            } catch (e) {
                console.error("Erro ao processar JSON de nutrição:", e);
            }
        }

        res.json({ reply, nutrition: nutritionData });

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
    app.listen(port, () => console.log(`Server acting on port ${port}`));
}

module.exports = app;
