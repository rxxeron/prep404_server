const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://hrgiscymbpqatlzrefrt.supabase.co';
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || (() => { throw new Error('SUPABASE_ANON_KEY is not set'); })());

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testSupabase() {
  console.log('Testing Supabase Anon Queries...');
  
  const { data: divisions, error: divErr } = await supabase.from('divisions').select('name_en, name_bn').limit(4);
  console.log('Divisions sample:', divisions, divErr);

  const { data: unis, error: uniErr } = await supabase.from('universities').select('code, short_name, campus_location');
  console.log('Universities (' + (unis ? unis.length : 0) + '):', unis ? unis.map(u => u.code) : uniErr);

  const { data: progs, error: progErr } = await supabase.from('programs').select('name, track_category, total_credits').limit(4);
  console.log('Programs sample:', progs, progErr);

  const { data: insts, error: instErr } = await supabase.from('institutions').select('eiin, name_en, is_college').limit(4);
  console.log('Institutions sample:', insts, instErr);
}

testSupabase();
