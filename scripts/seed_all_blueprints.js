const path = require('path');
const { Client } = require(path.resolve(__dirname, '../node_modules/pg'));
require(path.resolve(__dirname, '../node_modules/dotenv')).config({ path: path.resolve(__dirname, '../.env') });
const client = new Client({ connectionString: process.env.DATABASE_URL });

const blueprints = [
  {
    id: 'nsu_seps',
    university_code: 'nsu',
    program_title: 'School of Engineering & Physical Sciences',
    degree_name: 'CSE, EEE, Civil & Environmental Engineering',
    total_marks: 100,
    duration_minutes: 120,
    negative_marking: 0,
    cutoff_target_percentage: 75,
    sections: [
      { id: 'eng', marks: 30, title: 'General English & Vocab', weight: 0.3, color_hex: '#3B82F6', chapters: 'Grammar, Reading Comprehension, Sentence Completion' },
      { id: 'quant_math', marks: 30, title: 'Quantitative Math', weight: 0.3, color_hex: '#10B981', chapters: 'Algebra, Arithmetic, Basic Geometry, Word Problems' },
      { id: 'high_math', marks: 25, title: 'Higher Math', weight: 0.25, color_hex: '#F59E0B', chapters: 'Calculus, Trigonometry, Vectors, Matrices' },
      { id: 'science', marks: 15, title: 'Physics & Science Mechanics', weight: 0.15, color_hex: '#8B5CF6', chapters: 'Newtonian Mechanics, Thermodynamics, Optics' }
    ]
  },
  {
    id: 'nsu_sbe',
    university_code: 'nsu',
    program_title: 'School of Business & Economics',
    degree_name: 'Bachelor of Business Administration (BBA)',
    total_marks: 100,
    duration_minutes: 120,
    negative_marking: 0,
    cutoff_target_percentage: 72,
    sections: [
      { id: 'eng', marks: 40, title: 'English Language & Comprehension', weight: 0.4, color_hex: '#3B82F6', chapters: 'Grammar, Analytical Reading, Verbal Reasoning' },
      { id: 'quant_math', marks: 40, title: 'Quantitative Reasoning', weight: 0.4, color_hex: '#10B981', chapters: 'Basic Algebra, Ratios, Statistics, Problem Solving' },
      { id: 'essay', marks: 20, title: 'Written Expression & Essay', weight: 0.2, color_hex: '#EC4899', chapters: 'Descriptive Writing, Argumentative Essays' }
    ]
  },
  {
    id: 'nsu_shls',
    university_code: 'nsu',
    program_title: 'School of Health & Life Sciences',
    degree_name: 'Bachelor of Pharmacy (B.Pharm Professional)',
    total_marks: 100,
    duration_minutes: 120,
    negative_marking: 0,
    cutoff_target_percentage: 78,
    sections: [
      { id: 'chem', marks: 35, title: 'Chemistry Core', weight: 0.35, color_hex: '#10B981', chapters: 'Organic Chemistry, Solutions, Reaction Kinetics, Bonding' },
      { id: 'bio', marks: 30, title: 'Biology & Physiology', weight: 0.3, color_hex: '#06B6D4', chapters: 'Cell Biology, Genetics, Human Physiology, Plant Anatomy' },
      { id: 'eng', marks: 20, title: 'English Comprehension', weight: 0.2, color_hex: '#3B82F6', chapters: 'Technical Vocabulary, Scientific Passages' },
      { id: 'math', marks: 15, title: 'Basic Quantitative Math', weight: 0.15, color_hex: '#F59E0B', chapters: 'Ratios, Percentage, Basic Algebra' }
    ]
  },
  {
    id: 'brac_cse',
    university_code: 'brac',
    program_title: 'School of Data & Sciences',
    degree_name: 'Computer Science & Engineering',
    total_marks: 50,
    duration_minutes: 60,
    negative_marking: 0.25,
    cutoff_target_percentage: 85,
    sections: [
      { id: 'eng', marks: 20, title: 'English Grammar & Reading', weight: 0.4, color_hex: '#10B981', chapters: 'Sentence Correction, Passage, Critical Thinking' },
      { id: 'math', marks: 20, title: 'Higher Mathematics', weight: 0.4, color_hex: '#3B82F6', chapters: 'Functions, Differentiation, Integration, Matrices & Geometry' },
      { id: 'phy', marks: 10, title: 'Physics Fundamentals', weight: 0.2, color_hex: '#F59E0B', chapters: 'Newtonian Mechanics, Waves, Electricity, Modern Physics' }
    ]
  },
  {
    id: 'brac_bbs',
    university_code: 'brac',
    program_title: 'BRAC Business School',
    degree_name: 'Bachelor of Business Administration (BBA)',
    total_marks: 50,
    duration_minutes: 60,
    negative_marking: 0.25,
    cutoff_target_percentage: 75,
    sections: [
      { id: 'eng', marks: 25, title: 'English Verbal Reasoning', weight: 0.5, color_hex: '#3B82F6', chapters: 'Reading Comprehension, Vocabulary, Syntax' },
      { id: 'math', marks: 25, title: 'Quantitative Aptitude', weight: 0.5, color_hex: '#10B981', chapters: 'Number Properties, Arithmetic, Word Problems' }
    ]
  },
  {
    id: 'ewu_eng',
    university_code: 'ewu',
    program_title: 'Faculty of Sciences & Engineering',
    degree_name: 'CSE, EEE, ICE',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 75,
    sections: [
      { id: 'math', marks: 35, title: 'Higher Mathematics', weight: 0.35, color_hex: '#FF7A36', chapters: 'Calculus, Trigonometry, Vectors, Conics' },
      { id: 'phy', marks: 25, title: 'Physics Fundamentals', weight: 0.25, color_hex: '#FFD166', chapters: 'Mechanics, Electromagnetism, Modern Physics' },
      { id: 'chem', marks: 20, title: 'Chemistry Science', weight: 0.2, color_hex: '#542747', chapters: 'Organic Reactions, Chemical Equilibrium, Periodic Properties' },
      { id: 'eng', marks: 20, title: 'General English', weight: 0.2, color_hex: '#7A3667', chapters: 'Sentence Completion, Grammar, Vocabulary' }
    ]
  },
  {
    id: 'ewu_fba',
    university_code: 'ewu',
    program_title: 'Faculty of Business & Economics',
    degree_name: 'Bachelor of Business Administration (BBA)',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 70,
    sections: [
      { id: 'eng', marks: 40, title: 'English Language', weight: 0.4, color_hex: '#3B82F6', chapters: 'Sentence Structure, Cloze Test, Reading Passages' },
      { id: 'math', marks: 40, title: 'Mathematics & Logical Thinking', weight: 0.4, color_hex: '#10B981', chapters: 'Arithmetic, Profit-Loss, Algebra, Data Interpretation' },
      { id: 'gk', marks: 20, title: 'General Knowledge & Current Affairs', weight: 0.2, color_hex: '#F59E0B', chapters: 'Bangladesh Studies, Global Economy, Technology' }
    ]
  },
  {
    id: 'iub_sets',
    university_code: 'iub',
    program_title: 'SETS Engineering Unit',
    degree_name: 'CSE, EEE, Computer Engineering',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 80,
    sections: [
      { id: 'eng', marks: 30, title: 'English Comprehension & Vocab', weight: 0.3, color_hex: '#6366F1', chapters: 'Reading Comprehension, Sentence Correction, Vocabulary' },
      { id: 'gen_math', marks: 30, title: 'General Mathematics', weight: 0.3, color_hex: '#06B6D4', chapters: 'Arithmetic, Basic Algebra, Coordinate Geometry' },
      { id: 'high_math', marks: 20, title: 'Higher Mathematics', weight: 0.2, color_hex: '#F59E0B', chapters: 'Calculus, Vectors, Trigonometry' },
      { id: 'phy', marks: 20, title: 'Physics for SETS', weight: 0.2, color_hex: '#EF4444', chapters: 'Mechanics, Electricity, Magnetism' }
    ]
  },
  {
    id: 'iub_sb',
    university_code: 'iub',
    program_title: 'School of Business and Entrepreneurship',
    degree_name: 'BBA in Marketing, Finance, Accounting, MIS',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 72,
    sections: [
      { id: 'eng', marks: 50, title: 'English Proficiency', weight: 0.5, color_hex: '#6366F1', chapters: 'Reading Comprehension, Grammar Rules, Vocabulary' },
      { id: 'math', marks: 50, title: 'Quantitative Reasoning', weight: 0.5, color_hex: '#06B6D4', chapters: 'Arithmetic, Fractions, Percentages, Business Math' }
    ]
  },
  {
    id: 'uiu_cse',
    university_code: 'uiu',
    program_title: 'School of Science & Engineering',
    degree_name: 'Computer Science & Engineering, Data Science',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 75,
    sections: [
      { id: 'math', marks: 40, title: 'Higher Mathematics', weight: 0.4, color_hex: '#FF7A36', chapters: 'Differentiation, Integration, Vectors, Matrices, Trigonometry' },
      { id: 'phy', marks: 30, title: 'Physics Fundamentals', weight: 0.3, color_hex: '#FFD166', chapters: 'Mechanics, Waves, Thermodynamics, Electricity' },
      { id: 'eng', marks: 30, title: 'English Communication', weight: 0.3, color_hex: '#542747', chapters: 'Grammar, Comprehension, Sentence Completion' }
    ]
  },
  {
    id: 'aiub_eng',
    university_code: 'aiub',
    program_title: 'Faculty of Engineering & CS',
    degree_name: 'CSE, EEE, Computer Engineering',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 70,
    sections: [
      { id: 'math', marks: 35, title: 'Mathematics', weight: 0.35, color_hex: '#FF7A36', chapters: 'Calculus, Algebra, Coordinate Geometry' },
      { id: 'phy', marks: 30, title: 'Physics', weight: 0.3, color_hex: '#FFD166', chapters: 'Newtonian Mechanics, Work Power Energy, Electricity' },
      { id: 'chem', marks: 15, title: 'Chemistry', weight: 0.15, color_hex: '#542747', chapters: 'Organic Chemistry, Periodic Table, Chemical Bonds' },
      { id: 'eng', marks: 20, title: 'English Language', weight: 0.2, color_hex: '#7A3667', chapters: 'Grammar, Vocabulary, Sentence Correction' }
    ]
  },
  {
    id: 'aust_eng',
    university_code: 'aust',
    program_title: 'Faculty of Engineering',
    degree_name: 'CSE, EEE, Civil, Mechanical, Textile',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 82,
    sections: [
      { id: 'math', marks: 35, title: 'Higher Mathematics', weight: 0.35, color_hex: '#FF7A36', chapters: 'Calculus, Vectors, Trigonometry, Matrices, Conics' },
      { id: 'phy', marks: 35, title: 'Physics Fundamentals', weight: 0.35, color_hex: '#FFD166', chapters: 'Mechanics, Electricity, Modern Physics, Optics' },
      { id: 'chem', marks: 20, title: 'Chemistry Science', weight: 0.2, color_hex: '#542747', chapters: 'Organic Reactions, Stoichiometry, Equilibrium' },
      { id: 'eng', marks: 10, title: 'English Language', weight: 0.1, color_hex: '#7A3667', chapters: 'Grammar, Syntax & Sentence Correction' }
    ]
  },
  {
    id: 'uap_cse',
    university_code: 'uap',
    program_title: 'School of Science & Engineering',
    degree_name: 'Computer Science & Engineering',
    total_marks: 100,
    duration_minutes: 90,
    negative_marking: 0.25,
    cutoff_target_percentage: 70,
    sections: [
      { id: 'math', marks: 35, title: 'Mathematics', weight: 0.35, color_hex: '#FF7A36', chapters: 'Coordinate Geometry, Differentiation, Integration' },
      { id: 'phy', marks: 30, title: 'Physics', weight: 0.3, color_hex: '#FFD166', chapters: 'Mechanics, Gravitation, Electricity' },
      { id: 'eng', marks: 20, title: 'English Proficiency', weight: 0.2, color_hex: '#7A3667', chapters: 'Reading Passages, Sentence Completion, Vocab' },
      { id: 'chem', marks: 15, title: 'Basic Chemistry', weight: 0.15, color_hex: '#542747', chapters: 'Atomic Structure, Chemical Reactions' }
    ]
  }
];

async function seed() {
  await client.connect();
  console.log(`Upserting ${blueprints.length} blueprints into university_blueprints table...`);
  
  for (const bp of blueprints) {
    const query = `
      INSERT INTO university_blueprints (
        id, university_code, program_title, degree_name, total_marks,
        duration_minutes, negative_marking, cutoff_target_percentage, sections, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        university_code = EXCLUDED.university_code,
        program_title = EXCLUDED.program_title,
        degree_name = EXCLUDED.degree_name,
        total_marks = EXCLUDED.total_marks,
        duration_minutes = EXCLUDED.duration_minutes,
        negative_marking = EXCLUDED.negative_marking,
        cutoff_target_percentage = EXCLUDED.cutoff_target_percentage,
        sections = EXCLUDED.sections;
    `;
    await client.query(query, [
      bp.id,
      bp.university_code,
      bp.program_title,
      bp.degree_name,
      bp.total_marks,
      bp.duration_minutes,
      bp.negative_marking,
      bp.cutoff_target_percentage,
      JSON.stringify(bp.sections)
    ]);
    console.log(`✓ Upserted blueprint: ${bp.id}`);
  }

  const countRes = await client.query("SELECT COUNT(*) FROM university_blueprints;");
  console.log(`Total blueprints in DB now: ${countRes.rows[0].count}`);
  await client.end();
}

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
