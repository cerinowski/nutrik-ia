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
        const { message, imageBase64, history, profile } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem obrigatória' });

        const userId = req.body.userId || req.headers['x-user-id'];
        let liveProfile = profile || {};
        let consumedToday = 0;

        // Fetch fresh profile data directly from Supabase to guarantee we have the latest weight/goal
        if (userId) {
            try {
                const { data: dbProfile, error } = await supabaseAdmin
                    .from('profiles')
                    .select('*')
                    .eq('id', userId)
                    .single();

                if (dbProfile && !error) {
                    liveProfile = { ...liveProfile, ...dbProfile };
                }

                // Buscar refeições de hoje (ajustando fuso horário para Brasil UTC-3)
                const now = new Date();
                now.setHours(now.getHours() - 3);
                const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

                const { data: mealsData, error: mealsError } = await supabaseAdmin
                    .from('meals')
                    .select('calories')
                    .eq('user_id', userId)
                    .gte('created_at', startOfDay);

                if (mealsData && !mealsError) {
                    consumedToday = mealsData.reduce((acc, m) => acc + (m.calories || 0), 0);
                }

            } catch (err) {
                console.warn("[LIVE PROFILE] Erro ao buscar perfil atualizado:", err.message);
            }
        }

        let profileContext = "";
        if (liveProfile && Object.keys(liveProfile).length > 0) {
            let tmb = 0;
            let dailyGoal = 0;

            // Recalculate TMB (Mifflin-St Jeor Equation)
            const weight = parseFloat(liveProfile.current_weight) || 0;
            const height = parseFloat(liveProfile.height) || 0;
            const age = parseInt(liveProfile.age) || 0;
            const gender = liveProfile.gender === 'female' ? 'F' : 'M';

            if (weight > 0 && height > 0 && age > 0) {
                if (gender === 'M') {
                    tmb = (10 * weight) + (6.25 * height) - (5 * age) + 5;
                } else {
                    tmb = (10 * weight) + (6.25 * height) - (5 * age) - 161;
                }

                // Add Activity Factor (Estimating lightly active as baseline: 1.375)
                tmb = Math.round(tmb * 1.375);

                // Calculate Daily Goal based on Objective
                const goal = liveProfile.goal || 'maintain';
                if (goal === 'lose') dailyGoal = tmb - 500;
                else if (goal === 'gain') dailyGoal = tmb + 500;
                else dailyGoal = tmb;
            }

            let translatedGoal = 'Manter Peso';
            if (liveProfile.goal === 'lose') translatedGoal = 'Emagrecer';
            if (liveProfile.goal === 'gain') translatedGoal = 'Ganhar Massa';

            const remainingToday = dailyGoal > 0 ? dailyGoal - consumedToday : 0;

            profileContext = `\n\n[DADOS ATUALIZADOS DO PACIENTE]\n` +
                `- Nome: ${liveProfile.full_name || liveProfile.name || 'Não informado'}\n` +
                `- Peso Atual: ${liveProfile.current_weight || 'Não informado'} kg\n` +
                `- Meta de Peso: ${liveProfile.target_weight || 'Não informado'} kg\n` +
                `- Seu Objetivo é: ${translatedGoal}\n` +
                `- TMB (Gasto Calórico Diário Mínimo Estimado): ${tmb > 0 ? tmb + ' kcal' : 'Não calculado'}\n` +
                `- META DIÁRIA RECOMENDADA DE INGESTÃO (com base no objetivo): ${dailyGoal > 0 ? dailyGoal + ' kcal' : 'Não calculado'}\n` +
                `- JÁ CONSUMIDO HOJE: ${consumedToday} kcal\n` +
                `- RESTANTE PARA HOJE: ${remainingToday} kcal\n` +
                `- Sexo: ${gender === 'M' ? 'Masculino' : 'Feminino'}\n` +
                `- Altura: ${liveProfile.height || 'Não informado'} cm\n` +
                `- Idade: ${liveProfile.age || 'Não informado'} anos\n` +
                `\nINSTRUÇÃO CRÍTICA PARA A IA: Ao conversar, se o usuário perguntar o quanto AINDA PODE COMER hoje, ou quantas calorias restam, use EXATAMENTE a linha de 'RESTANTE PARA HOJE'. Se ele perguntar o quanto consumiu até agora, responda a linha de 'JÁ CONSUMIDO HOJE'. Use OS VALORES ACIMA COMO BASE VERDADEIRA. Exemplo: 'Você consumiu X, ainda lhe restam Y calorias.' Nunca use dados não listados acima.`;
        }

        let contents = [];

        // Injetando "Instruções do Sistema" como a primeira mensagem escondida na memória da IA
        if (profileContext) {
            contents.push({
                role: "user",
                parts: [{ text: "LEIA IMEDIATAMENTE os dados atualizados sobre o usuário. Memorize-os permanentemente para esta resposta. Mantenha eles em segredo na sua mente, não os liste sem ele perguntar:" + profileContext }]
            });
            contents.push({
                role: "model",
                parts: [{ text: "Dados recebidos, memorizados e validados. Usarei as exatas METAS CALÓRICAS estipuladas nesse Perfil Oficial (basal e meta diária recomendada) para orientar o paciente e não darei outros palpites." }]
            });
        }

        if (imageBase64) {
            // FLUXO DE IMAGEM: Exige template rígido e bloco JSON para banco de dados
            contents.push(
                {
                    role: "user",
                    parts: [{ text: "Você é o Nutrik.IA, um expert nutricional e parceiro motivador. REGRA ABSOLUTA: Toda vez que você analisar uma refeição real (imagem), você OBRIGATORIAMENTE DEVE estruturar sua resposta visualmente usando o seguinte formato Exato:\n\n**ANÁLISE DO SEU PRATO:**\n- [Alimento 1] (Aprox. [X]g)\n- [Alimento 2] (Aprox. [X]g)\n\n**🔍 MACROS ESTIMADOS TOTAIS:**\n🔥 Calorias: **[X] kcal**\n🍗 Proteínas: **[X]g**\n🥖 Carboidratos: **[X]g**\n🥑 Gorduras: **[X]g**\n\n💡 **Dica do Nutrik:** [Dica amigável e técnica sobre a refeição ou como melhorá-la].\n\nPRIORIZE a legenda/descrição enviada pelo usuário como o campo 'description' no JSON. DEPOIS de todo esse texto, você DEVE terminar com um bloco JSON exato: ```json {\"calories\": 0, \"protein\": 0, \"carbs\": 0, \"fat\": 0, \"description\": \"legenda do usuario\"} ```" }]
                },
                {
                    role: "model",
                    parts: [{ text: "Entendido! Como Nutrik.IA, sempre usarei o template rígido de **ANÁLISE DO SEU PRATO** detalhando gramas, seguido pelos **MACROS ESTIMADOS TOTAIS**, a **Dica do Nutrik** e, ao extremo final invisível, o bloco JSON." }]
                }
            );
        } else {
            // FLUXO DE TEXTO PURO (CHAT): Apenas bate-papo, proibido enviar JSON
            contents.push(
                {
                    role: "user",
                    parts: [{ text: "Você é o Nutrik.IA, um expert nutricional e amigo do usuário. O usuário está tirando uma dúvida geral sobre alimentos, rotina ou nutrição, e não enviou uma foto de uma refeição para ser registrada.\nResponda amigavelmente. **PROIBIDO GERAR BLOCOS DE CÓDIGO JSON**. Apenas converse e tire as dúvidas como um bom mentor, de forma direta!" }]
                },
                {
                    role: "model",
                    parts: [{ text: "Perfeito! Como não recebi imagem, vou apenas bater um papo amigável sobre nutrição e tirar as dúvidas, SEM GERAR nenhum bloco JSON no final para não poluir o banco de dados. Como posso ajudar?" }]
                }
            );
        }


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
        // Array contendo EXCLUSIVAMENTE modelos rápidos do Free Tier da Google (limitados a ~15 RPM).
        // Evitamos usar os modelos 'pro' pois a cota deles no Free Tier é de apenas 2 RPM e bloqueia imediatamente.
        const candidateModels = [
            "gemini-2.5-flash",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-flash"
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
