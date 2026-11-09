const supabaseUrl = 'https://hrgiscymbpqatlzrefrt.supabase.co';
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || (() => { throw new Error('SUPABASE_ANON_KEY is not set'); })());

async function testRest() {
  const headers = {
    'apikey': supabaseAnonKey,
    'Authorization': `Bearer ${supabaseAnonKey}`
  };

  const resDiv = await fetch(`${supabaseUrl}/rest/v1/divisions?select=name_en,name_bn`, { headers });
  const divisions = await resDiv.json();
  console.log('Divisions (' + divisions.length + '):', divisions);

  const resUni = await fetch(`${supabaseUrl}/rest/v1/universities?select=code,short_name,campus_location`, { headers });
  const unis = await resUni.json();
  console.log('Universities (' + unis.length + '):', unis.map(u => u.code));

  const resProg = await fetch(`${supabaseUrl}/rest/v1/programs?select=name,track_category,total_credits&limit=5`, { headers });
  const progs = await resProg.json();
  console.log('Programs sample (' + progs.length + '):', progs);

  const resInst = await fetch(`${supabaseUrl}/rest/v1/institutions?select=eiin,name_en,is_college&limit=5`, { headers });
  const insts = await resInst.json();
  console.log('Institutions sample (' + insts.length + '):', insts);
}

testRest();
