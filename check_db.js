require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkProfiles() {
    console.log("Checking Users...");
    const { data: users, error: errAuth } = await supabase.auth.admin.listUsers();
    if (errAuth) {
        console.log("Admin API error (might not be service key):", errAuth.message);
        console.log("Trying to just fetch profiles instead...");
    } else {
        console.log("Users:", users.users.map(u => ({ id: u.id, email: u.email })));
    }

    const { data: profiles, error: errProf } = await supabase.from('profiles').select('*');
    if (errProf) {
        console.log("Profiles fetch error:", errProf.message);
    } else {
        console.log("Profiles:", profiles);
    }
}

checkProfiles();
