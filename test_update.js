require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Using service role key (process.env.SUPABASE_KEY is usually the service role key if they set it up for admin tasks)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function testUpdate() {
    console.log("Fetching a profile to test...");
    const { data: profiles, error: errProf } = await supabase.from('profiles').select('*').limit(1);

    if (errProf || !profiles || profiles.length === 0) {
        console.log("No profiles found or error:", errProf);
        return;
    }

    const testId = profiles[0].id;
    console.log("Found profile:", profiles[0]);

    // Test update with service key (bypasses RLS)
    const { data: updateData, error: updateErr } = await supabase
        .from('profiles')
        .update({ credits: profiles[0].credits })
        .eq('id', testId)
        .select();

    console.log("Service key update result:", { data: updateData, error: updateErr });
}

testUpdate();
