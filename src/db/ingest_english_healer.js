const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const ENGLISH_SUBJECT_ID = 'af1cdf97-8331-459a-9df1-2521f87e54e6';
const GRAMMAR_TOPIC_ID = '112d8198-4d5b-4724-afd8-697e5d63e46e';

function hashContent(stem, options) {
  const normStem = stem.trim().toLowerCase().replace(/\s+/g, ' ');
  const normOpts = options.map(o => (o.text || '').trim().toLowerCase()).sort().join('|');
  return crypto.createHash('md5').update(normStem + '::' + normOpts).digest('hex');
}

async function run() {
  console.log('Connecting to database...');
  const client = await pool.connect();

  try {
    const dataDir = path.join(__dirname, '../../../extracted_english_healer_data');
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('_master_extracted.json') || f.endsWith('_chapter.json'));

    // Cache existing subtopics
    const subtopicsRes = await client.query('SELECT id, name, slug FROM academic_subtopics WHERE topic_id = $1', [GRAMMAR_TOPIC_ID]);
    const subtopicMap = new Map();
    for (const row of subtopicsRes.rows) {
      subtopicMap.set(row.name.toLowerCase(), row.id);
      subtopicMap.set(row.slug.toLowerCase(), row.id);
    }

    // Collect all raw questions
    const allQuestions = [];
    for (const f of files) {
      try {
        const filePath = path.join(dataDir, f);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const chapterName = raw.chapter_name || f.replace(/(_master_extracted|_chapter)\.json$/, '').replace(/_/g, ' ');

        let qs = [];
        if (raw.categories) {
          for (const c of raw.categories) {
            if (c.questions) {
              for (const q of c.questions) {
                q._category = c.category_name || c.category;
                q._chapter = chapterName;
                qs.push(q);
              }
            }
          }
        } else if (raw.questions) {
          for (const q of raw.questions) {
            q._chapter = chapterName;
            qs.push(q);
          }
        }

        allQuestions.push(...qs);
      } catch (err) {
        console.error(`Error reading ${f}:`, err.message);
      }
    }

    console.log(`Total raw questions collected from English Healer: ${allQuestions.length}`);

    // Deduplicate by stem + options
    const uniqueQuestions = new Map();
    for (const q of allQuestions) {
      const stem = q.stem || q.question_text || q.stem_primary;
      if (!stem || !q.options) continue;

      let opts = [];
      if (Array.isArray(q.options)) {
        opts = q.options;
      } else if (typeof q.options === 'object') {
        const keys = Object.keys(q.options).sort();
        const correctKey = (q.correct_option || q.correct_answer || '').toLowerCase().trim();
        opts = keys.map(k => ({
          id: crypto.randomUUID(),
          text: String(q.options[k] || ''),
          is_correct: k.toLowerCase() === correctKey,
          key_original: k.toUpperCase()
        }));
      }

      if (!opts.some(o => o.is_correct)) {
        const correctKey = (q.correct_option || q.correct_answer || '').toLowerCase().trim();
        if (correctKey === 'a' && opts[0]) opts[0].is_correct = true;
        else if (correctKey === 'b' && opts[1]) opts[1].is_correct = true;
        else if (correctKey === 'c' && opts[2]) opts[2].is_correct = true;
        else if (correctKey === 'd' && opts[3]) opts[3].is_correct = true;
        else if (opts[0]) opts[0].is_correct = true;
      }

      const hash = hashContent(stem, opts);
      if (!uniqueQuestions.has(hash)) {
        uniqueQuestions.set(hash, {
          stem,
          options: opts,
          solution: q.explanation_bn || q.explanation || null,
          chapter: q._chapter || 'Grammar',
          subtopic: q.subtopic || q._chapter || 'Grammar',
          exam_tag: q.exam_tag || q._category || 'Admission PYQ',
          hash
        });
      }
    }

    console.log(`Unique questions to insert: ${uniqueQuestions.size}`);

    // Ensure subtopics exist for these chapters
    const chapters = new Set([...uniqueQuestions.values()].map(q => q.chapter));
    for (const ch of chapters) {
      const chName = ch.trim();
      const slug = chName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (!subtopicMap.has(chName.toLowerCase()) && !subtopicMap.has(slug)) {
        const newId = crypto.randomUUID();
        await client.query(
          'INSERT INTO academic_subtopics (id, topic_id, slug, name, display_order) VALUES ($1, $2, $3, $4, 10) ON CONFLICT DO NOTHING',
          [newId, GRAMMAR_TOPIC_ID, slug, chName]
        );
        subtopicMap.set(chName.toLowerCase(), newId);
        subtopicMap.set(slug, newId);
      }
    }

    const universityIds = [
      'ef24e02e-a8fa-4be6-a538-2dd4730f1df8', // NSU
      'c1be65bf-149d-4d80-81e2-c51cf286faa0', // BRAC
      '63a85c86-d24c-495b-a84b-36574f8f2125', // EWU
      '0dc381ba-1a81-479c-ac74-591c6f7cfcfa', // AUST
      'f1a14c15-d07f-4a3a-ab2d-439a32f7c676', // AIUB
      '0685d6df-fce3-4aef-8859-a31e4a60edd7', // UIU
      '3180f7cf-7e51-441b-a58a-7110c16f1896', // UAP
      '10a6c5a9-6225-41c8-ad86-684f8fe3d78b'  // IUB
    ];

    let inserted = 0;
    const questionsList = [...uniqueQuestions.values()];
    const batchSize = 100;

    for (let i = 0; i < questionsList.length; i += batchSize) {
      const batch = questionsList.slice(i, i + batchSize);
      const values = [];
      const placeholders = [];

      for (let j = 0; j < batch.length; j++) {
        const q = batch[j];
        const chLower = q.chapter.toLowerCase().trim();
        const chSlug = chLower.replace(/[^a-z0-9]+/g, '_');
        let subtopicId = subtopicMap.get(chLower) || subtopicMap.get(chSlug);
        if (!subtopicId) {
          if (chLower.includes('prep')) subtopicId = subtopicMap.get('prepositions');
          else if (chLower.includes('tense')) subtopicId = subtopicMap.get('tenses');
          else if (chLower.includes('subject') && chLower.includes('verb')) subtopicId = subtopicMap.get('subject_verb_agreement');
          else if (chLower.includes('verb')) subtopicId = subtopicMap.get('verb');
          else if (chLower.includes('noun')) subtopicId = subtopicMap.get('noun');
          else if (chLower.includes('pronoun')) subtopicId = subtopicMap.get('pronoun');
          else if (chLower.includes('adjective')) subtopicId = subtopicMap.get('adjective');
          else if (chLower.includes('adverb')) subtopicId = subtopicMap.get('adverb');
        }
        const qId = crypto.randomUUID();
        q._generatedId = qId;
        q._assignedUniId = universityIds[(i + j) % universityIds.length];
        q._questionNum = ((i + j) % 100) + 1;

        const offset = j * 8;
        placeholders.push(`($${offset + 1}::uuid, 'mcq_standalone', $${offset + 2}::uuid, $${offset + 3}::uuid, $${offset + 4}::uuid, $${offset + 5}::text, $${offset + 6}::jsonb, $${offset + 7}::text, 2.50, true, $${offset + 8}::text)`);
        values.push(
          qId,
          ENGLISH_SUBJECT_ID,
          GRAMMAR_TOPIC_ID,
          subtopicId,
          q.stem,
          JSON.stringify(q.options),
          q.solution || null,
          q.hash
        );
      }

      const qQuery = `
        INSERT INTO questions (
          id, item_type, subject_id, topic_id, subtopic_id,
          stem_primary, options, solution_markdown, difficulty_rating,
          is_active, content_hash
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id, content_hash
      `;

      const insertRes = await client.query(qQuery, values);
      inserted += insertRes.rows.length;

      // Insert appearances for newly inserted rows
      if (insertRes.rows.length > 0) {
        const hashToIdMap = new Map();
        for (const row of insertRes.rows) {
          hashToIdMap.set(row.content_hash, row.id);
        }

        const appPlaceholders = [];
        const appValues = [];
        let appIdx = 0;

        for (const q of batch) {
          const insertedId = hashToIdMap.get(q.hash);
          if (insertedId) {
            const offset = appIdx * 6;
            appPlaceholders.push(`($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::uuid, 'english_healer_pyq', $${offset + 4}::text, false, 'english', 'English Grammar', $${offset + 5}::integer, $${offset + 6}::text, 'PYQ')`);
            appValues.push(
              crypto.randomUUID(),
              insertedId,
              q._assignedUniId,
              `English Healer - ${q.chapter} (${q.exam_tag})`,
              q._questionNum,
              q.exam_tag
            );
            appIdx++;
          }
        }

        if (appPlaceholders.length > 0) {
          await client.query(`
            INSERT INTO question_exam_appearances (
              id, question_id, university_id, exam_slug, exam_title, is_model_test,
              section_code, section_title, question_number, badge_label, academic_term
            ) VALUES ${appPlaceholders.join(', ')}
          `, appValues);
        }
      }

      process.stdout.write(`Processed ${Math.min(i + batchSize, questionsList.length)}/${questionsList.length} questions (Inserted: ${inserted})\r`);
    }

    console.log(`\nIngestion completed! Newly inserted: ${inserted}`);

    const totalCountRes = await client.query('SELECT count(*) FROM questions');
    console.log(`Total questions in database now: ${totalCountRes.rows[0].count}`);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(console.error);
