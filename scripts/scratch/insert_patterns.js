const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || (() => { throw new Error('DATABASE_URL is not set'); })()),
  ssl: { rejectUnauthorized: false }
});

const patterns = [
  // BRACU
  {
    uniCode: 'BRACU',
    slug: 'eng',
    name: 'BRAC University Engineering & CSE Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English Proficiency', marks: 30, questions: 30, topics: ['Syntax', 'Grammar', 'Reading Comprehension'] },
      { name: 'Higher Mathematics', marks: 50, questions: 50, topics: ['Calculus', 'Coordinate Geometry', 'Vectors', 'Algebra'] },
      { name: 'Physics Fundamentals', marks: 20, questions: 20, topics: ['Mechanics', 'Waves', 'Electricity'] }
    ]
  },
  {
    uniCode: 'BRACU',
    slug: 'bba',
    name: 'BRAC University Business & BBA Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English Language & Reading', marks: 40, questions: 40, topics: ['Sentence Correction', 'Comprehension', 'Vocabulary'] },
      { name: 'Quantitative Mathematics', marks: 40, questions: 40, topics: ['Arithmetic', 'Algebra', 'Word Problems'] },
      { name: 'Viva Voce & Communication', marks: 20, questions: 0, topics: ['Analytical Aptitude', 'Communication Skills'] }
    ]
  },
  {
    uniCode: 'BRACU',
    slug: 'arch',
    name: 'BRAC University Architecture & Design Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 150,
    neg: 0.0,
    hasViva: true,
    sections: [
      { name: 'English Proficiency', marks: 25, questions: 25, topics: ['Grammar', 'Reading Comprehension'] },
      { name: 'General Mathematics', marks: 25, questions: 25, topics: ['Geometry', 'Trigonometry', 'Algebra'] },
      { name: 'Freehand Drawing & Visual Arts', marks: 50, questions: 2, topics: ['Perspective Drawing', 'Light & Shade', 'Spatial Composition'] }
    ]
  },
  {
    uniCode: 'BRACU',
    slug: 'pharm',
    name: 'BRAC University Pharmacy & Life Sciences Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English Proficiency', marks: 25, questions: 25, topics: ['Vocabulary', 'Syntax', 'Comprehension'] },
      { name: 'Chemistry', marks: 40, questions: 40, topics: ['Organic Chemistry', 'Chemical Bonding', 'Stoichiometry'] },
      { name: 'Biology', marks: 35, questions: 35, topics: ['Cell Biology', 'Genetics', 'Botany & Zoology'] }
    ]
  },
  {
    uniCode: 'BRACU',
    slug: 'law',
    name: 'BRAC University Law & Justice Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'Advanced English & Legal Reasoning', marks: 50, questions: 50, topics: ['Critical Reading', 'Legal Vocabulary', 'Grammar'] },
      { name: 'General Knowledge & Constitution', marks: 30, questions: 30, topics: ['Bangladesh Affairs', 'Constitution', 'Current Affairs'] },
      { name: 'Viva Voce', marks: 20, questions: 0, topics: ['Oral Argument', 'Ethical Reasoning'] }
    ]
  },
  {
    uniCode: 'BRACU',
    slug: 'sciences',
    name: 'BRAC University Natural & Physical Sciences Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English Proficiency', marks: 20, questions: 20, topics: ['Grammar', 'Comprehension'] },
      { name: 'Mathematics & Physics', marks: 50, questions: 50, topics: ['Calculus', 'Mechanics', 'Thermodynamics'] },
      { name: 'Chemistry & Biology', marks: 30, questions: 30, topics: ['General Chemistry', 'Biological Systems'] }
    ]
  },
  {
    uniCode: 'BRACU',
    slug: 'humanities',
    name: 'BRAC University Humanities & Social Sciences Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English Language Skills', marks: 50, questions: 50, topics: ['Syntax', 'Vocabulary', 'Essay & Reading'] },
      { name: 'General Knowledge & Logic', marks: 30, questions: 30, topics: ['History', 'Sociology Basics', 'Logical Reasoning'] },
      { name: 'Viva Voce', marks: 20, questions: 0, topics: ['Personal Aptitude', 'Communication'] }
    ]
  },

  // NSU
  {
    uniCode: 'NSU',
    slug: 'pharm',
    name: 'NSU Pharmacy & Life Sciences Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 120,
    neg: 0.0,
    hasViva: false,
    sections: [
      { name: 'General English', marks: 30, questions: 30, topics: ['Grammar', 'Vocabulary', 'Reading'] },
      { name: 'Chemistry', marks: 35, questions: 35, topics: ['Organic Chemistry', 'Equilibrium', 'Atomic Structure'] },
      { name: 'Biology', marks: 35, questions: 35, topics: ['Cell Physiology', 'Genetics', 'Ecology'] }
    ]
  },
  {
    uniCode: 'NSU',
    slug: 'arch',
    name: 'NSU Architecture Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 150,
    neg: 0.0,
    hasViva: false,
    sections: [
      { name: 'General English', marks: 25, questions: 25, topics: ['Grammar', 'Reading Comprehension'] },
      { name: 'Quantitative Math', marks: 35, questions: 35, topics: ['Geometry', 'Algebra', 'Trigonometry'] },
      { name: 'Freehand Drawing & Design', marks: 40, questions: 2, topics: ['3D Visualization', 'Perspective Drawing', 'Shading'] }
    ]
  },
  {
    uniCode: 'NSU',
    slug: 'law',
    name: 'NSU Law & Justice Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 120,
    neg: 0.0,
    hasViva: false,
    sections: [
      { name: 'Advanced English & Comprehension', marks: 50, questions: 50, topics: ['Sentence Correction', 'Critical Reasoning', 'Passages'] },
      { name: 'Quantitative Math & Logic', marks: 40, questions: 40, topics: ['Basic Algebra', 'Logic Puzzles', 'Percentages'] },
      { name: 'Essay / Writing', marks: 10, questions: 1, topics: ['Persuasive Argument Essay'] }
    ]
  },

  // AUST
  {
    uniCode: 'AUST',
    slug: 'bba',
    name: 'AUST School of Business Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 90,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English Language & Comprehension', marks: 40, questions: 40, topics: ['Reading Passages', 'Syntax', 'Vocabulary'] },
      { name: 'General Mathematics & Quant', marks: 40, questions: 40, topics: ['Algebra', 'Percentages', 'Profit-Loss', 'Geometry'] },
      { name: 'Analytical Reasoning & GK', marks: 20, questions: 20, topics: ['Critical Thinking', 'Bangladesh & Global Affairs'] }
    ]
  },
  {
    uniCode: 'AUST',
    slug: 'arch',
    name: 'AUST Architecture Units Admission Test',
    archetype: 'nctb_science',
    marks: 150,
    duration: 150,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'Higher Mathematics & Physics', marks: 50, questions: 25, topics: ['Trigonometry', 'Vectors', 'Mechanics'] },
      { name: 'English Proficiency', marks: 25, questions: 25, topics: ['Grammar', 'Reading Comprehension'] },
      { name: 'Freehand Drawing & Perception', marks: 75, questions: 2, topics: ['Spatial Composition', 'Isometric Perspective', 'Visual Art'] }
    ]
  },

  // IUB
  {
    uniCode: 'IUB',
    slug: 'eng',
    name: 'IUB Engineering & Physical Sciences (SETS) Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English Proficiency', marks: 30, questions: 30, topics: ['Comprehension', 'Grammar'] },
      { name: 'Quantitative Math', marks: 30, questions: 30, topics: ['Algebra', 'Arithmetic Reasoning'] },
      { name: 'Higher Math & Physics', marks: 40, questions: 40, topics: ['Calculus', 'Mechanics', 'Electricity'] }
    ]
  },
  {
    uniCode: 'IUB',
    slug: 'bba',
    name: 'IUB School of Business & Entrepreneurship (SBE) Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 90,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English Comprehension & Grammar', marks: 45, questions: 45, topics: ['Reading', 'Syntax', 'Vocabulary'] },
      { name: 'Business Math & Quantitative', marks: 45, questions: 45, topics: ['Algebra', 'Percentages', 'Ratios'] },
      { name: 'General Awareness & Logic', marks: 10, questions: 10, topics: ['Analytical Puzzles', 'Business Trends'] }
    ]
  },
  {
    uniCode: 'IUB',
    slug: 'pharm',
    name: 'IUB Pharmacy & Public Health Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English Proficiency', marks: 30, questions: 30, topics: ['Syntax', 'Comprehension'] },
      { name: 'Chemistry', marks: 35, questions: 35, topics: ['Organic Chemistry', 'Stoichiometry'] },
      { name: 'Biology', marks: 35, questions: 35, topics: ['Human Biology', 'Genetics'] }
    ]
  },

  // EWU
  {
    uniCode: 'EWU',
    slug: 'eng',
    name: 'EWU Engineering & Applied Sciences Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English Language', marks: 30, questions: 30, topics: ['Grammar', 'Reading'] },
      { name: 'Mathematics & Physics', marks: 50, questions: 50, topics: ['Calculus', 'Algebra', 'Mechanics'] },
      { name: 'General Knowledge & Logic', marks: 20, questions: 20, topics: ['Analytical Puzzles', 'Current Affairs'] }
    ]
  },
  {
    uniCode: 'EWU',
    slug: 'bba',
    name: 'EWU Business & Economics Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 90,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English Comprehension & Grammar', marks: 40, questions: 40, topics: ['Sentence Correction', 'Comprehension'] },
      { name: 'Quantitative & General Math', marks: 40, questions: 40, topics: ['Algebra', 'Percentages', 'Word Problems'] },
      { name: 'Analytical & GK', marks: 20, questions: 20, topics: ['Logic', 'Current Events'] }
    ]
  },
  {
    uniCode: 'EWU',
    slug: 'pharm',
    name: 'EWU Pharmacy Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English', marks: 25, questions: 25, topics: ['Vocabulary', 'Syntax'] },
      { name: 'Chemistry', marks: 40, questions: 40, topics: ['Organic', 'Inorganic Chemistry'] },
      { name: 'Biology', marks: 35, questions: 35, topics: ['Botany', 'Zoology', 'Physiology'] }
    ]
  },

  // UIU
  {
    uniCode: 'UIU',
    slug: 'eng',
    name: 'UIU Engineering (CSE/EEE/Civil) Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English', marks: 30, questions: 30, topics: ['Grammar', 'Reading'] },
      { name: 'Higher Mathematics', marks: 50, questions: 50, topics: ['Calculus', 'Vectors', 'Coordinate Geometry'] },
      { name: 'Physics', marks: 20, questions: 20, topics: ['Electricity', 'Mechanics'] }
    ]
  },
  {
    uniCode: 'UIU',
    slug: 'bba',
    name: 'UIU School of Business & Economics Admission Test',
    archetype: 'sat_aptitude',
    marks: 100,
    duration: 90,
    neg: 0.25,
    hasViva: false,
    sections: [
      { name: 'English Grammar & Comprehension', marks: 50, questions: 50, topics: ['Comprehension', 'Vocabulary', 'Sentence Structure'] },
      { name: 'Quantitative & Business Math', marks: 50, questions: 50, topics: ['Basic Algebra', 'Ratios', 'Percentages'] }
    ]
  },

  // AIUB
  {
    uniCode: 'AIUB',
    slug: 'bba',
    name: 'AIUB Faculty of Business Administration (FBA) Exam',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 90,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English Proficiency', marks: 40, questions: 40, topics: ['Grammar', 'Reading Comprehension'] },
      { name: 'General Mathematics', marks: 40, questions: 40, topics: ['Algebra', 'Percentages', 'Arithmetic'] },
      { name: 'Viva Voce', marks: 20, questions: 0, topics: ['Oral Interview', 'Academic Interest'] }
    ]
  },
  {
    uniCode: 'AIUB',
    slug: 'arch',
    name: 'AIUB Architecture Drawing & Aptitude Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English & Basic Math', marks: 40, questions: 40, topics: ['English Grammar', 'Geometry Basics'] },
      { name: 'Freehand Drawing & Design', marks: 40, questions: 2, topics: ['Spatial Sketching', 'Perspective Drawing'] },
      { name: 'Viva Voce', marks: 20, questions: 0, topics: ['Portfolio Review', 'Design Interview'] }
    ]
  },

  // UAP
  {
    uniCode: 'UAP',
    slug: 'eng',
    name: 'UAP Engineering Admission Test & Viva',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English', marks: 30, questions: 30, topics: ['Grammar', 'Sentence Structure'] },
      { name: 'Higher Mathematics', marks: 40, questions: 40, topics: ['Calculus', 'Algebra'] },
      { name: 'Physics', marks: 20, questions: 20, topics: ['Mechanics', 'Electricity'] },
      { name: 'Viva Voce', marks: 10, questions: 0, topics: ['Oral Interview'] }
    ]
  },
  {
    uniCode: 'UAP',
    slug: 'bba',
    name: 'UAP Business Administration Admission Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 90,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English Language', marks: 40, questions: 40, topics: ['Grammar', 'Comprehension'] },
      { name: 'General Mathematics', marks: 40, questions: 40, topics: ['Algebra', 'Percentages'] },
      { name: 'Viva Voce', marks: 20, questions: 0, topics: ['Interview & Communication'] }
    ]
  },
  {
    uniCode: 'UAP',
    slug: 'arch',
    name: 'UAP Architecture Drawing & Aptitude Test',
    archetype: 'hybrid_viva',
    marks: 100,
    duration: 120,
    neg: 0.25,
    hasViva: true,
    sections: [
      { name: 'English & Basic Math', marks: 30, questions: 30, topics: ['English', 'Geometry'] },
      { name: 'Freehand Drawing & Creativity', marks: 50, questions: 2, topics: ['Perspective Drawing', 'Object Sketching'] },
      { name: 'Viva Voce', marks: 20, questions: 0, topics: ['Portfolio & Design Aptitude'] }
    ]
  }
];

async function main() {
  console.log('Inserting / updating comprehensive admission test patterns...');
  const uniRes = await pool.query('SELECT id, code FROM universities;');
  const uniMap = {};
  uniRes.rows.forEach(u => { uniMap[u.code] = u.id; });

  for (const p of patterns) {
    const uniId = uniMap[p.uniCode];
    if (!uniId) {
      console.log(`University ${p.uniCode} not found, skipping.`);
      continue;
    }

    await pool.query(`
      INSERT INTO admission_test_patterns (
        id, university_id, slug, pattern_name, test_archetype,
        total_marks, duration_minutes, has_negative_marking,
        negative_marking_penalty, has_viva, sections, created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
      )
      ON CONFLICT (university_id, slug) DO UPDATE SET
        pattern_name = EXCLUDED.pattern_name,
        test_archetype = EXCLUDED.test_archetype,
        total_marks = EXCLUDED.total_marks,
        duration_minutes = EXCLUDED.duration_minutes,
        has_negative_marking = EXCLUDED.has_negative_marking,
        negative_marking_penalty = EXCLUDED.negative_marking_penalty,
        has_viva = EXCLUDED.has_viva,
        sections = EXCLUDED.sections;
    `, [
      randomUUID(),
      uniId,
      p.slug,
      p.name,
      p.archetype,
      p.marks,
      p.duration,
      p.neg > 0,
      p.neg,
      p.hasViva,
      JSON.stringify(p.sections)
    ]);

    console.log(`✓ Processed ${p.uniCode} -> ${p.slug} (${p.name})`);
  }

  console.log('Done inserting admission test patterns into live database!');
  process.exit(0);
}

main().catch(err => {
  console.error('Error inserting patterns:', err);
  process.exit(1);
});
