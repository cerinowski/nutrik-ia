const testPayload = {
    message: "Teste continuação",
    imageBase64: null,
    history: [
        { role: "user", text: "Minha altura é 1.80m" },
        { role: "model", text: "Legal! Anotei sua altura." }
    ]
};

async function testFetch() {
    try {
        const res = await fetch('http://localhost:3000/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload)
        });
        const data = await res.json();
        console.log("RESPONSE:", data);
    } catch (e) {
        console.error("FETCH ERROR:", e);
    }
}
testFetch();
