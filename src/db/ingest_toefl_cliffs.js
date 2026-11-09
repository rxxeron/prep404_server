const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const NSU_UNI_ID = 'ef24e02e-a8fa-4be6-a538-2dd4730f1df8';
const ENGLISH_SUBJECT_ID = 'af1cdf97-8331-459a-9df1-2521f87e54e6';
const GRAMMAR_TOPIC_ID = '112d8198-4d5b-4724-afd8-697e5d63e46e';

function toDeterministicUuid(str) {
  const hash = crypto.createHash('sha1').update(str).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '5' + hash.substring(13, 16),
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
    hash.substring(20, 32)
  ].join('-');
}

function hashContent(stem, options) {
  const normStem = stem.trim().toLowerCase().replace(/\s+/g, ' ');
  const normOpts = options.map(o => (o.text || '').trim().toLowerCase()).sort().join('|');
  return crypto.createHash('md5').update(normStem + '::' + normOpts).digest('hex');
}

// 50 Questions from Mini-Test 1 (Book pages 106-112, Answer Key 246-248)
const miniTest1 = [
  {
    num: 1,
    stem: "Buying clothes (A)[are] often a (B)[very time-consuming] practice because those clothes (C)[that fit] him or her are rarely the ones that please (D)[him or her].",
    options: [
      { key: "A", text: "are", is_correct: true },
      { key: "B", text: "very time-consuming", is_correct: false },
      { key: "C", text: "that fit", is_correct: false },
      { key: "D", text: "him or her", is_correct: false }
    ],
    explanation: "(A) should be 'is'. Use a singular verb when a gerund [verb + ing] ('Buying clothes') is the subject.",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 2,
    stem: "Because they had spent (A)[too many] time (B)[considering] the new contract, the students lost the opportunity (C)[to lease] (D)[the] apartment.",
    options: [
      { key: "A", text: "too many", is_correct: true },
      { key: "B", text: "considering", is_correct: false },
      { key: "C", text: "to lease", is_correct: false },
      { key: "D", text: "the", is_correct: false }
    ],
    explanation: "(A) should be 'too much'. 'Time' in this context is an uncountable (non-count) noun.",
    subtopic: "Noun"
  },
  {
    num: 3,
    stem: "(A)[These] televisions are all (B)[too expensive] (C)[for we to buy] at (D)[this time], but perhaps we will return later.",
    options: [
      { key: "A", text: "These", is_correct: false },
      { key: "B", text: "too expensive", is_correct: false },
      { key: "C", text: "for we to buy", is_correct: true },
      { key: "D", text: "this time", is_correct: false }
    ],
    explanation: "(C) should be 'for us to buy'. Use object pronouns ('us') after prepositions like 'for'.",
    subtopic: "Pronoun"
  },
  {
    num: 4,
    stem: "After she (A)[had bought] (B)[himself] a new automobile, (C)[she sold] (D)[her] bicycle.",
    options: [
      { key: "A", text: "had bought", is_correct: false },
      { key: "B", text: "himself", is_correct: true },
      { key: "C", text: "she sold", is_correct: false },
      { key: "D", text: "her", is_correct: false }
    ],
    explanation: "(B) should be 'herself'. The subject is 'she', so the reflexive pronoun must be 'herself'.",
    subtopic: "Pronoun"
  },
  {
    num: 5,
    stem: "The next (A)[important] question we have (B)[to decide] is (C)[when do we have to] (D)[submit] the proposal.",
    options: [
      { key: "A", text: "important", is_correct: false },
      { key: "B", text: "to decide", is_correct: false },
      { key: "C", text: "when do we have to", is_correct: true },
      { key: "D", text: "submit", is_correct: false }
    ],
    explanation: "(C) should be 'when we have to'. In embedded questions, use affirmative word order: [question word + subject + verb].",
    subtopic: "Sentence Structure"
  },
  {
    num: 6,
    stem: "George (A)[has not completed] the assignment (B)[yet], and Maria (C)[hasn't neither] (D)[either].",
    options: [
      { key: "A", text: "has not completed", is_correct: false },
      { key: "B", text: "yet", is_correct: false },
      { key: "C", text: "hasn't neither", is_correct: true },
      { key: "D", text: "either", is_correct: false }
    ],
    explanation: "(C) should be 'hasn't either' or 'neither has Maria'. Avoid double negatives in negative agreement.",
    subtopic: "Sentence Structure"
  },
  {
    num: 7,
    stem: "John (A)[decided to] buy (B)[in the morning a new car], (C)[but] in the afternoon he changed (D)[his mind].",
    options: [
      { key: "A", text: "decided to", is_correct: false },
      { key: "B", text: "in the morning a new car", is_correct: true },
      { key: "C", text: "but", is_correct: false },
      { key: "D", text: "his mind", is_correct: false }
    ],
    explanation: "(B) should be 'a new car in the morning'. Standard sentence pattern requires [Subject + Verb + Complement + Modifier].",
    subtopic: "Sentence Structure"
  },
  {
    num: 8,
    stem: "Some of the plants in this store require (A)[very little] care, but (B)[this one] needs (C)[much more] sunlight than (D)[the others ones].",
    options: [
      { key: "A", text: "very little", is_correct: false },
      { key: "B", text: "this one", is_correct: false },
      { key: "C", text: "much more", is_correct: false },
      { key: "D", text: "the others ones", is_correct: true }
    ],
    explanation: "(D) should be 'the other ones' or 'the others'. 'Other' as an adjective before a noun cannot take plural -s.",
    subtopic: "Adjective"
  },
  {
    num: 9,
    stem: "After George (A)[has returned] to (B)[his house], he (C)[was reading] (D)[a book].",
    options: [
      { key: "A", text: "has returned", is_correct: true },
      { key: "B", text: "his house", is_correct: false },
      { key: "C", text: "was reading", is_correct: false },
      { key: "D", text: "a book", is_correct: false }
    ],
    explanation: "(A) should be 'had returned'. Use past perfect for the earlier of two past actions.",
    subtopic: "Tenses"
  },
  {
    num: 10,
    stem: "Many theories on (A)[conserving] the purity of water (B)[has been] proposed, (C)[but not one] has been as (D)[widely] accepted as this one.",
    options: [
      { key: "A", text: "conserving", is_correct: false },
      { key: "B", text: "has been", is_correct: true },
      { key: "C", text: "but not one", is_correct: false },
      { key: "D", text: "widely", is_correct: false }
    ],
    explanation: "(B) should be 'have been'. The subject is the plural noun 'theories', not 'water'.",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 11,
    stem: "The food (A)[that] Mark (B)[is cooking] in the kitchen (C)[is smelling] (D)[delicious].",
    options: [
      { key: "A", text: "that", is_correct: false },
      { key: "B", text: "is cooking", is_correct: false },
      { key: "C", text: "is smelling", is_correct: true },
      { key: "D", text: "delicious", is_correct: false }
    ],
    explanation: "(C) should be 'smells'. Stative linking verbs of perception ('smell', 'taste', 'sound') do not take continuous forms.",
    subtopic: "Verb"
  },
  {
    num: 12,
    stem: "After John (A)[eaten] dinner, he (B)[wrote] (C)[several] letters and (D)[went] to bed.",
    options: [
      { key: "A", text: "eaten", is_correct: true },
      { key: "B", text: "wrote", is_correct: false },
      { key: "C", text: "several", is_correct: false },
      { key: "D", text: "went", is_correct: false }
    ],
    explanation: "(A) should be 'had eaten' or 'ate'. Past participle 'eaten' cannot serve as finite verb without auxiliary.",
    subtopic: "Tenses"
  },
  {
    num: 13,
    stem: "The manager (A)[has finished] working (B)[on the report] last night, and now she (C)[will begin] to write (D)[the other] proposal.",
    options: [
      { key: "A", text: "has finished", is_correct: true },
      { key: "B", text: "on the report", is_correct: false },
      { key: "C", text: "will begin", is_correct: false },
      { key: "D", text: "the other", is_correct: false }
    ],
    explanation: "(A) should be 'finished'. Specific past time adverbials ('last night') mandate simple past, not present perfect.",
    subtopic: "Tenses"
  },
  {
    num: 14,
    stem: "Because Sam and Michelle (A)[had done] all of the work (B)[theirselves], they (C)[were] unwilling to give (D)[the results] to Joan.",
    options: [
      { key: "A", text: "had done", is_correct: false },
      { key: "B", text: "theirselves", is_correct: true },
      { key: "C", text: "were", is_correct: false },
      { key: "D", text: "the results", is_correct: false }
    ],
    explanation: "(B) should be 'themselves'. 'Theirselves' is non-standard English.",
    subtopic: "Pronoun"
  },
  {
    num: 15,
    stem: "Daniel said that if he (A)[had to] do (B)[another] homework tonight, he (C)[would not be] able (D)[to attend] the concert.",
    options: [
      { key: "A", text: "had to", is_correct: false },
      { key: "B", text: "another", is_correct: true },
      { key: "C", text: "would not be", is_correct: false },
      { key: "D", text: "to attend", is_correct: false }
    ],
    explanation: "(B) should be 'more' or 'any more'. 'Homework' is an uncountable noun and cannot be preceded by 'another'.",
    subtopic: "Noun"
  },
  {
    num: 16,
    stem: "After (A)[to take] the medication, the patient (B)[became] drowsy and (C)[more] (D)[manageable].",
    options: [
      { key: "A", text: "to take", is_correct: true },
      { key: "B", text: "became", is_correct: false },
      { key: "C", text: "more", is_correct: false },
      { key: "D", text: "manageable", is_correct: false }
    ],
    explanation: "(A) should be 'taking'. Prepositions (like 'after') must be followed by a gerund [verb + ing], not an infinitive.",
    subtopic: "Verb"
  },
  {
    num: 17,
    stem: "We insist (A)[on you] (B)[leaving] the meeting (C)[before] any further outbursts (D)[take place].",
    options: [
      { key: "A", text: "on you", is_correct: true },
      { key: "B", text: "leaving", is_correct: false },
      { key: "C", text: "before", is_correct: false },
      { key: "D", text: "take place", is_correct: false }
    ],
    explanation: "(A) should be 'on your'. In formal standard grammar, a possessive determiner ('your') precedes the gerund ('leaving').",
    subtopic: "Pronoun"
  },
  {
    num: 18,
    stem: "(A)[It has been] a long time (B)[since] we (C)[have talked] to John, (D)[isn't it]?",
    options: [
      { key: "A", text: "It has been", is_correct: false },
      { key: "B", text: "since", is_correct: false },
      { key: "C", text: "have talked", is_correct: false },
      { key: "D", text: "isn't it", is_correct: true }
    ],
    explanation: "(D) should be 'hasn't it?'. The auxiliary verb in the main clause is 'has', so the tag must use 'hasn't it?'.",
    subtopic: "Sentence Structure"
  },
  {
    num: 19,
    stem: "Henry objects (A)[to our] buying this house (B)[without] the approval of our attorney, and John (C)[does so] (D)[too].",
    options: [
      { key: "A", text: "to our", is_correct: false },
      { key: "B", text: "without", is_correct: false },
      { key: "C", text: "does so", is_correct: true },
      { key: "D", text: "too", is_correct: false }
    ],
    explanation: "(C) should be 'does too' or 'so does John'. 'does so' is an improper hybrid of affirmative agreement.",
    subtopic: "Sentence Structure"
  },
  {
    num: 20,
    stem: "Rita enjoyed (A)[to be] able (B)[to meet] several members of Congress (C)[during] (D)[her] vacation.",
    options: [
      { key: "A", text: "to be", is_correct: true },
      { key: "B", text: "to meet", is_correct: false },
      { key: "C", text: "during", is_correct: false },
      { key: "D", text: "her", is_correct: false }
    ],
    explanation: "(A) should be 'being'. The verb 'enjoy' must be followed by a gerund, not an infinitive.",
    subtopic: "Verb"
  },
  {
    num: 21,
    stem: "After (A)[being indicted] (B)[for] his part in a bank robbery, the reputed mobster (C)[decided find] (D)[another] attorney.",
    options: [
      { key: "A", text: "being indicted", is_correct: false },
      { key: "B", text: "for", is_correct: false },
      { key: "C", text: "decided find", is_correct: true },
      { key: "D", text: "another", is_correct: false }
    ],
    explanation: "(C) should be 'decided to find'. The verb 'decide' requires an infinitive [to + verb].",
    subtopic: "Verb"
  },
  {
    num: 22,
    stem: "Harry's advisor (A)[persuaded] (B)[his taking] several courses (C)[which did] not involve (D)[much knowledge] of mathematics.",
    options: [
      { key: "A", text: "persuaded", is_correct: false },
      { key: "B", text: "his taking", is_correct: true },
      { key: "C", text: "which did", is_correct: false },
      { key: "D", text: "much knowledge", is_correct: false }
    ],
    explanation: "(B) should be 'him to take'. The pattern for persuade is [persuade + pronoun object + infinitive].",
    subtopic: "Verb"
  },
  {
    num: 23,
    stem: "The only teachers (A)[who were] required (B)[to attend] the meeting (C)[were] George, Betty, Jill, and (D)[me].",
    options: [
      { key: "A", text: "who were", is_correct: false },
      { key: "B", text: "to attend", is_correct: false },
      { key: "C", text: "were", is_correct: false },
      { key: "D", text: "me", is_correct: true }
    ],
    explanation: "(D) should be 'I'. After linking verbs like 'were', predicate nominatives require subject pronouns ('I').",
    subtopic: "Pronoun"
  },
  {
    num: 24,
    stem: "The work (A)[performed] by these officers (B)[are] not worth our (C)[paying] (D)[them] any longer.",
    options: [
      { key: "A", text: "performed", is_correct: false },
      { key: "B", text: "are", is_correct: true },
      { key: "C", text: "paying", is_correct: false },
      { key: "D", text: "them", is_correct: false }
    ],
    explanation: "(B) should be 'is'. The head subject 'work' is singular uncountable, requiring singular 'is'.",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 25,
    stem: "The president (A)[went] (B)[fishing] after he (C)[has finished] with the (D)[conferences].",
    options: [
      { key: "A", text: "went", is_correct: false },
      { key: "B", text: "fishing", is_correct: false },
      { key: "C", text: "has finished", is_correct: true },
      { key: "D", text: "conferences", is_correct: false }
    ],
    explanation: "(C) should be 'had finished'. The conference was completed before he went fishing in the past.",
    subtopic: "Tenses"
  },
  {
    num: 26,
    stem: "Peter and Tom (A)[plays] tennis (B)[every afternoon] (C)[with] (D)[Mary and me].",
    options: [
      { key: "A", text: "plays", is_correct: true },
      { key: "B", text: "every afternoon", is_correct: false },
      { key: "C", text: "with", is_correct: false },
      { key: "D", text: "Mary and me", is_correct: false }
    ],
    explanation: "(A) should be 'play'. Compound subject joined by 'and' requires plural verb.",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 27,
    stem: "There (A)[were] a time (B)[that] I (C)[used to swim] five laps every day, but now I do not have (D)[enough time].",
    options: [
      { key: "A", text: "were", is_correct: true },
      { key: "B", text: "that", is_correct: false },
      { key: "C", text: "used to swim", is_correct: false },
      { key: "D", text: "enough time", is_correct: false }
    ],
    explanation: "(A) should be 'was'. Expletive 'there' takes verb agreeing with the true subject 'a time' (singular).",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 28,
    stem: "He (A)[was drink] a cup (B)[of coffee] (C)[when] the telephone (D)[rang].",
    options: [
      { key: "A", text: "was drink", is_correct: true },
      { key: "B", text: "of coffee", is_correct: false },
      { key: "C", text: "when", is_correct: false },
      { key: "D", text: "rang", is_correct: false }
    ],
    explanation: "(A) should be 'was drinking'. Past continuous requires [was/were + verb-ing].",
    subtopic: "Tenses"
  },
  {
    num: 29,
    stem: "We called (A)[yesterday our friends] in Boston (B)[to tell] them (C)[about] the reunion that we are (D)[planning].",
    options: [
      { key: "A", text: "yesterday our friends", is_correct: true },
      { key: "B", text: "to tell", is_correct: false },
      { key: "C", text: "about", is_correct: false },
      { key: "D", text: "planning", is_correct: false }
    ],
    explanation: "(A) should be 'our friends in Boston yesterday'. Direct object ('our friends') precedes time modifier ('yesterday').",
    subtopic: "Sentence Structure"
  },
  {
    num: 30,
    stem: "The children (A)[were playing] (B)[last night outdoors] (C)[when] it began to rain (D)[very hard].",
    options: [
      { key: "A", text: "were playing", is_correct: false },
      { key: "B", text: "last night outdoors", is_correct: true },
      { key: "C", text: "when", is_correct: false },
      { key: "D", text: "very hard", is_correct: false }
    ],
    explanation: "(B) should be 'outdoors last night'. Adverb of place ('outdoors') precedes adverb of time ('last night').",
    subtopic: "Sentence Structure"
  },
  {
    num: 31,
    stem: "(A)[Those] homework that your teacher (B)[assigned] is due (C)[on Tuesday] unless you have made prior arrangements to turn it (D)[in late].",
    options: [
      { key: "A", text: "Those", is_correct: true },
      { key: "B", text: "assigned", is_correct: false },
      { key: "C", text: "on Tuesday", is_correct: false },
      { key: "D", text: "in late", is_correct: false }
    ],
    explanation: "(A) should be 'That'. 'Homework' is uncountable, so demonstrative must be singular 'That'.",
    subtopic: "Noun"
  },
  {
    num: 32,
    stem: "(A)[Please] give me (B)[a few] coffee (C)[and] some donuts (D)[if] you have any left.",
    options: [
      { key: "A", text: "Please", is_correct: false },
      { key: "B", text: "a few", is_correct: true },
      { key: "C", text: "and", is_correct: false },
      { key: "D", text: "if", is_correct: false }
    ],
    explanation: "(B) should be 'a little' or 'some'. 'Coffee' is non-count; 'a few' is only used with count nouns.",
    subtopic: "Noun"
  },
  {
    num: 33,
    stem: "There are ten (A)[childs] playing (B)[in the yard] near her house, (C)[but] your child is not (D)[among them].",
    options: [
      { key: "A", text: "childs", is_correct: true },
      { key: "B", text: "in the yard", is_correct: false },
      { key: "C", text: "but", is_correct: false },
      { key: "D", text: "among them", is_correct: false }
    ],
    explanation: "(A) should be 'children'. The irregular plural of child is 'children'.",
    subtopic: "Noun"
  },
  {
    num: 34,
    stem: "People (A)[respected] George Washington (B)[because] he was (C)[a honest] man, and he turned out to be one of our (D)[greatest] military leaders.",
    options: [
      { key: "A", text: "respected", is_correct: false },
      { key: "B", text: "because", is_correct: false },
      { key: "C", text: "a honest", is_correct: true },
      { key: "D", text: "greatest", is_correct: false }
    ],
    explanation: "(C) should be 'an honest'. 'Honest' begins with a silent 'h' and vowel sound /ɒ/, requiring 'an'.",
    subtopic: "Adjective"
  },
  {
    num: 35,
    stem: "He isn't (A)[driving] to the convention (B)[in March], and (C)[neither they are] (D)[planning] to go.",
    options: [
      { key: "A", text: "driving", is_correct: false },
      { key: "B", text: "in March", is_correct: false },
      { key: "C", text: "neither they are", is_correct: true },
      { key: "D", text: "planning", is_correct: false }
    ],
    explanation: "(C) should be 'neither are they'. Inverted word order follows 'neither' in negative agreement: [neither + auxiliary + subject].",
    subtopic: "Sentence Structure"
  },
  {
    num: 36,
    stem: "Catherine is (A)[studying] law (B)[at the university], and (C)[so does] (D)[John].",
    options: [
      { key: "A", text: "studying", is_correct: false },
      { key: "B", text: "at the university", is_correct: false },
      { key: "C", text: "so does", is_correct: true },
      { key: "D", text: "John", is_correct: false }
    ],
    explanation: "(C) should be 'so is'. The auxiliary in the first clause is 'is' (present continuous), so agreement takes 'so is John'.",
    subtopic: "Sentence Structure"
  },
  {
    num: 37,
    stem: "The company has (A)[so little] money (B)[that] it (C)[can't hardly] operate (D)[anymore].",
    options: [
      { key: "A", text: "so little", is_correct: false },
      { key: "B", text: "that", is_correct: false },
      { key: "C", text: "can't hardly", is_correct: true },
      { key: "D", text: "anymore", is_correct: false }
    ],
    explanation: "(C) should be 'can hardly'. 'Hardly' is already negative; pairing with 'can't' creates an erroneous double negative.",
    subtopic: "Sentence Structure"
  },
  {
    num: 38,
    stem: "My cousin attends (A)[an university] (B)[in the Midwest] (C)[which] (D)[specializes] in astronomy.",
    options: [
      { key: "A", text: "an university", is_correct: true },
      { key: "B", text: "in the Midwest", is_correct: false },
      { key: "C", text: "which", is_correct: false },
      { key: "D", text: "specializes", is_correct: false }
    ],
    explanation: "(A) should be 'a university'. 'University' starts with consonant glide /j/, requiring indefinite article 'a'.",
    subtopic: "Adjective"
  },
  {
    num: 39,
    stem: "The students were (A)[interested] (B)[in take] a field trip to The National History Museum, (C)[but] they were not able (D)[to raise] enough money.",
    options: [
      { key: "A", text: "interested", is_correct: false },
      { key: "B", text: "in take", is_correct: true },
      { key: "C", text: "but", is_correct: false },
      { key: "D", text: "to raise", is_correct: false }
    ],
    explanation: "(B) should be 'in taking'. Preposition 'in' must take the gerund form 'taking'.",
    subtopic: "Verb"
  },
  {
    num: 40,
    stem: "Because they (A)[have moved] away, they (B)[hardly never] go (C)[to the beach] (D)[anymore].",
    options: [
      { key: "A", text: "have moved", is_correct: false },
      { key: "B", text: "hardly never", is_correct: true },
      { key: "C", text: "to the beach", is_correct: false },
      { key: "D", text: "anymore", is_correct: false }
    ],
    explanation: "(B) should be 'hardly ever'. 'Hardly never' is an unacceptable double negative.",
    subtopic: "Sentence Structure"
  },
  {
    num: 41,
    stem: "(A)[Us students] (B)[would rather] not attend (C)[night classes] in the summer, but we often (D)[have to].",
    options: [
      { key: "A", text: "Us students", is_correct: true },
      { key: "B", text: "would rather", is_correct: false },
      { key: "C", text: "night classes", is_correct: false },
      { key: "D", text: "have to", is_correct: false }
    ],
    explanation: "(A) should be 'We students'. The pronoun functions as grammatical subject and must be in nominative case.",
    subtopic: "Pronoun"
  },
  {
    num: 42,
    stem: "The policeman (A)[ordered] the suspect (B)[to don't remove] (C)[his hands] (D)[from] the hood of the car.",
    options: [
      { key: "A", text: "ordered", is_correct: false },
      { key: "B", text: "to don't remove", is_correct: true },
      { key: "C", text: "his hands", is_correct: false },
      { key: "D", text: "from", is_correct: false }
    ],
    explanation: "(B) should be 'not to remove'. Negative indirect commands use [not + infinitive], never [to don't].",
    subtopic: "Verb"
  },
  {
    num: 43,
    stem: "It (A)[was him] who (B)[came running] (C)[into] the classroom (D)[with] the news.",
    options: [
      { key: "A", text: "was him", is_correct: true },
      { key: "B", text: "came running", is_correct: false },
      { key: "C", text: "into", is_correct: false },
      { key: "D", text: "with", is_correct: false }
    ],
    explanation: "(A) should be 'was he'. In formal English, predicate pronoun after linking verb 'was' takes nominative case ('he').",
    subtopic: "Pronoun"
  },
  {
    num: 44,
    stem: "My brother (A)[doesn't care] how much (B)[does the car cost] because he (C)[is going to] (D)[buy it] anyway.",
    options: [
      { key: "A", text: "doesn't care", is_correct: false },
      { key: "B", text: "does the car cost", is_correct: true },
      { key: "C", text: "is going to", is_correct: false },
      { key: "D", text: "buy it", is_correct: false }
    ],
    explanation: "(B) should be 'the car costs'. Embedded question clauses use declarative word order without auxiliary 'does'.",
    subtopic: "Sentence Structure"
  },
  {
    num: 45,
    stem: "Mary and her sister (A)[studied] biology (B)[last year], and (C)[so does] (D)[Jean].",
    options: [
      { key: "A", text: "studied", is_correct: false },
      { key: "B", text: "last year", is_correct: false },
      { key: "C", text: "so does", is_correct: true },
      { key: "D", text: "Jean", is_correct: false }
    ],
    explanation: "(C) should be 'so did'. The auxiliary must match the past tense of the main verb 'studied'.",
    subtopic: "Sentence Structure"
  },
  {
    num: 46,
    stem: "Pete (A)[had already saw] that musical (B)[before] he (C)[read] the reviews (D)[about it].",
    options: [
      { key: "A", text: "had already saw", is_correct: true },
      { key: "B", text: "before", is_correct: false },
      { key: "C", text: "read", is_correct: false },
      { key: "D", text: "about it", is_correct: false }
    ],
    explanation: "(A) should be 'had already seen'. Past perfect takes auxiliary 'had' + past participle 'seen', not past simple 'saw'.",
    subtopic: "Tenses"
  },
  {
    num: 47,
    stem: "(A)[There's] a new Oriental restaurant (B)[in town], (C)[isn't it] (D)[located] near the plaza?",
    options: [
      { key: "A", text: "There's", is_correct: false },
      { key: "B", text: "in town", is_correct: false },
      { key: "C", text: "isn't it", is_correct: true },
      { key: "D", text: "located", is_correct: false }
    ],
    explanation: "(C) should be 'isn't there?'. When 'there' occupies subject position, the question tag uses 'there'.",
    subtopic: "Sentence Structure"
  },
  {
    num: 48,
    stem: "The government (A)[has decided] (B)[voting] on the resolution (C)[now] rather than (D)[next month].",
    options: [
      { key: "A", text: "has decided", is_correct: false },
      { key: "B", text: "voting", is_correct: true },
      { key: "C", text: "now", is_correct: false },
      { key: "D", text: "next month", is_correct: false }
    ],
    explanation: "(B) should be 'to vote'. The verb 'decide' takes an infinitive, not a gerund.",
    subtopic: "Verb"
  },
  {
    num: 49,
    stem: "The professor (A)[is thinking] (B)[to go] to the conference (C)[on] aerodynamics (D)[next month].",
    options: [
      { key: "A", text: "is thinking", is_correct: false },
      { key: "B", text: "to go", is_correct: true },
      { key: "C", text: "on", is_correct: false },
      { key: "D", text: "next month", is_correct: false }
    ],
    explanation: "(B) should be 'of going' or 'about going'. 'Think' takes preposition + gerund, never infinitive.",
    subtopic: "Verb"
  },
  {
    num: 50,
    stem: "His father (A)[does not approve] of (B)[him to go] to the banquet (C)[without] dressing (D)[formally].",
    options: [
      { key: "A", text: "does not approve", is_correct: false },
      { key: "B", text: "him to go", is_correct: true },
      { key: "C", text: "without", is_correct: false },
      { key: "D", text: "formally", is_correct: false }
    ],
    explanation: "(B) should be 'his going'. After prepositions ('of'), use possessive determiner ('his') with gerund ('going').",
    subtopic: "Pronoun"
  }
];

// 50 Questions from Mini-Test 2 (Book pages 160-166, Answer Key 247-249)
const miniTest2 = [
  {
    num: 1,
    stem: "Children enjoy telling and listening to (A)[ghosts stories], (B)[especially] on (C)[Halloween] (D)[night].",
    options: [
      { key: "A", text: "ghosts stories", is_correct: true },
      { key: "B", text: "especially", is_correct: false },
      { key: "C", text: "Halloween", is_correct: false },
      { key: "D", text: "night", is_correct: false }
    ],
    explanation: "(A) should be 'ghost stories'. 'Ghost' functions as an adjective modifying 'stories' and cannot take plural -s.",
    subtopic: "Noun"
  },
  {
    num: 2,
    stem: "At the rate the clerks were processing the applications, Harry (A)[figured that] it will take four hours for (B)[his] to be (C)[reviewed] (D)[completely].",
    options: [
      { key: "A", text: "figured that", is_correct: false },
      { key: "B", text: "his", is_correct: false },
      { key: "C", text: "reviewed", is_correct: false },
      { key: "D", text: "will take", is_correct: true }
    ],
    explanation: "(D) should be 'would take'. Sequence of tenses: main verb 'figured' (past) requires past modal 'would take'.",
    subtopic: "Tenses"
  },
  {
    num: 3,
    stem: "No one (A)[would have attended] the lecture if you (B)[told] the truth (C)[about] the guest (D)[speaker].",
    options: [
      { key: "A", text: "would have attended", is_correct: false },
      { key: "B", text: "told", is_correct: true },
      { key: "C", text: "about", is_correct: false },
      { key: "D", text: "speaker", is_correct: false }
    ],
    explanation: "(B) should be 'had told'. Third conditional (past unreal condition) formula: [if + past perfect, would have + past participle].",
    subtopic: "Tenses"
  },
  {
    num: 4,
    stem: "We (A)[had better] to review this chapter carefully (B)[because] we will have some questions on it on (C)[our test] (D)[tomorrow].",
    options: [
      { key: "A", text: "had better to review", is_correct: true },
      { key: "B", text: "because", is_correct: false },
      { key: "C", text: "our test", is_correct: false },
      { key: "D", text: "tomorrow", is_correct: false }
    ],
    explanation: "(A) should be 'had better review'. 'Had better' is followed directly by the bare infinitive without 'to'.",
    subtopic: "Verb"
  },
  {
    num: 5,
    stem: "The little boy's mother bought him a (A)[five-speeds] racing bicycle (B)[for] his (C)[seventh] (D)[birthday].",
    options: [
      { key: "A", text: "five-speeds", is_correct: true },
      { key: "B", text: "for", is_correct: false },
      { key: "C", text: "seventh", is_correct: false },
      { key: "D", text: "birthday", is_correct: false }
    ],
    explanation: "(A) should be 'five-speed'. Hyphenated compound nouns functioning as adjectives remain singular.",
    subtopic: "Noun"
  },
  {
    num: 6,
    stem: "Despite the time of the year, yesterday's temperature was (A)[enough hot] to turn on the (B)[air conditioning] in (C)[the entire] (D)[building].",
    options: [
      { key: "A", text: "enough hot", is_correct: true },
      { key: "B", text: "air conditioning", is_correct: false },
      { key: "C", text: "the entire", is_correct: false },
      { key: "D", text: "building", is_correct: false }
    ],
    explanation: "(A) should be 'hot enough'. 'Enough' follows adjectives and adverbs: [adjective + enough].",
    subtopic: "Adjective"
  },
  {
    num: 7,
    stem: "The Andersons just had an enclosed (A)[bricks] patio (B)[built] after fighting off the insects for (C)[two] (D)[months].",
    options: [
      { key: "A", text: "bricks", is_correct: true },
      { key: "B", text: "built", is_correct: false },
      { key: "C", text: "two", is_correct: false },
      { key: "D", text: "months", is_correct: false }
    ],
    explanation: "(A) should be 'brick'. 'Brick' acts as an adjective modifying 'patio' and cannot be plural.",
    subtopic: "Noun"
  },
  {
    num: 8,
    stem: "Danny spent (A)[such enjoyable] vacation in Europe this summer (B)[that] he plans to return as soon as he (C)[saves] enough (D)[money].",
    options: [
      { key: "A", text: "such enjoyable", is_correct: true },
      { key: "B", text: "that", is_correct: false },
      { key: "C", text: "saves", is_correct: false },
      { key: "D", text: "money", is_correct: false }
    ],
    explanation: "(A) should be 'such an enjoyable'. Singular count nouns require an article: [such + a/an + adjective + noun].",
    subtopic: "Adjective"
  },
  {
    num: 9,
    stem: "Although the quantity was small, we had (A)[supplies enough] to finish (B)[the experiment] before the lab (C)[closed] (D)[for the day].",
    options: [
      { key: "A", text: "supplies enough", is_correct: true },
      { key: "B", text: "the experiment", is_correct: false },
      { key: "C", text: "closed", is_correct: false },
      { key: "D", text: "for the day", is_correct: false }
    ],
    explanation: "(A) should be 'enough supplies'. 'Enough' precedes nouns: [enough + noun].",
    subtopic: "Adjective"
  },
  {
    num: 10,
    stem: "Kurt had (A)[so interesting and creative] plans that everyone (B)[wanted] to work (C)[on his] (D)[committee].",
    options: [
      { key: "A", text: "so interesting and creative", is_correct: true },
      { key: "B", text: "wanted", is_correct: false },
      { key: "C", text: "on his", is_correct: false },
      { key: "D", text: "committee", is_correct: false }
    ],
    explanation: "(A) should be 'such interesting and creative plans'. When a noun ('plans') is present, use [such + adjective + plural noun].",
    subtopic: "Adjective"
  },
  {
    num: 11,
    stem: "If Rudy (A)[would have studied] German in college, he (B)[would not have found] the scientific terminology so (C)[difficult] (D)[to understand].",
    options: [
      { key: "A", text: "would have studied", is_correct: true },
      { key: "B", text: "would not have found", is_correct: false },
      { key: "C", text: "difficult", is_correct: false },
      { key: "D", text: "to understand", is_correct: false }
    ],
    explanation: "(A) should be 'had studied'. In conditional clauses, never use 'would have' directly inside the 'if' clause.",
    subtopic: "Tenses"
  },
  {
    num: 12,
    stem: "I have to (A)[depositing] this money in my checking account or (B)[else] the check I just wrote (C)[will] (D)[bounce].",
    options: [
      { key: "A", text: "depositing", is_correct: true },
      { key: "B", text: "else", is_correct: false },
      { key: "C", text: "will", is_correct: false },
      { key: "D", text: "bounce", is_correct: false }
    ],
    explanation: "(A) should be 'deposit'. 'Have to' takes the simple base form of the verb: [have to + verb].",
    subtopic: "Verb"
  },
  {
    num: 13,
    stem: "We wish today (A)[was] sunny so that we could spend the day (B)[in the country] (C)[communing] with (D)[nature].",
    options: [
      { key: "A", text: "was", is_correct: true },
      { key: "B", text: "in the country", is_correct: false },
      { key: "C", text: "communing", is_correct: false },
      { key: "D", text: "nature", is_correct: false }
    ],
    explanation: "(A) should be 'were'. In subjunctive expressions after 'wish', always use 'were' instead of 'was'.",
    subtopic: "Verb"
  },
  {
    num: 14,
    stem: "It (A)[was suggested] that John (B)[studies] the material carefully before (C)[taking] the comprehensive (D)[exam].",
    options: [
      { key: "A", text: "was suggested", is_correct: false },
      { key: "B", text: "studies", is_correct: true },
      { key: "C", text: "taking", is_correct: false },
      { key: "D", text: "exam", is_correct: false }
    ],
    explanation: "(B) should be 'study'. Subjunctive verbs after 'suggest that' require the base form without -s.",
    subtopic: "Verb"
  },
  {
    num: 15,
    stem: "The state law (A)[requires] that each candidate (B)[practices] law (C)[under] the supervision of a licensed (D)[attorney].",
    options: [
      { key: "A", text: "requires", is_correct: false },
      { key: "B", text: "practices", is_correct: true },
      { key: "C", text: "under", is_correct: false },
      { key: "D", text: "attorney", is_correct: false }
    ],
    explanation: "(B) should be 'practice'. Mandative subjunctive after 'require that' requires the simple base form.",
    subtopic: "Verb"
  },
  {
    num: 16,
    stem: "At this moment, the students (A)[study] in the library (B)[for] tomorrow's chemistry (C)[test] (D)[which starts early].",
    options: [
      { key: "A", text: "study", is_correct: true },
      { key: "B", text: "for", is_correct: false },
      { key: "C", text: "test", is_correct: false },
      { key: "D", text: "which starts early", is_correct: false }
    ],
    explanation: "(A) should be 'are studying'. 'At this moment' indicates an action in progress, requiring present progressive.",
    subtopic: "Tenses"
  },
  {
    num: 17,
    stem: "The teacher insists that the student (A)[sits] in the front row because (B)[his eyesight] is (C)[very poor] without (D)[glasses].",
    options: [
      { key: "A", text: "sits", is_correct: true },
      { key: "B", text: "his eyesight", is_correct: false },
      { key: "C", text: "very poor", is_correct: false },
      { key: "D", text: "glasses", is_correct: false }
    ],
    explanation: "(A) should be 'sit'. The subjunctive verb following 'insist that' must be in simple form.",
    subtopic: "Verb"
  },
  {
    num: 18,
    stem: "The coach advised that (A)[he is] present at all team meetings (B)[if] he expected (C)[to play] on (D)[Saturday].",
    options: [
      { key: "A", text: "he is", is_correct: true },
      { key: "B", text: "if", is_correct: false },
      { key: "C", text: "to play", is_correct: false },
      { key: "D", text: "Saturday", is_correct: false }
    ],
    explanation: "(A) should be 'he be'. Subjunctive after 'advise that' requires base form 'be'.",
    subtopic: "Verb"
  },
  {
    num: 19,
    stem: "Not only (A)[did he lose] his wallet, (B)[also he lost] his passport (C)[while] traveling (D)[abroad].",
    options: [
      { key: "A", text: "did he lose", is_correct: false },
      { key: "B", text: "also he lost", is_correct: true },
      { key: "C", text: "while", is_correct: false },
      { key: "D", text: "abroad", is_correct: false }
    ],
    explanation: "(B) should be 'but he also lost'. Correlative conjunction formula is [not only ... but also].",
    subtopic: "Conjunction & Linkers"
  },
  {
    num: 20,
    stem: "The doctor (A)[recommended] that the patient (B)[takes] a vacation and (C)[avoids] strenuous (D)[exercise].",
    options: [
      { key: "A", text: "recommended", is_correct: false },
      { key: "B", text: "takes", is_correct: true },
      { key: "C", text: "avoids", is_correct: false },
      { key: "D", text: "exercise", is_correct: false }
    ],
    explanation: "(B) should be 'take'. Subjunctive mood after 'recommend that' requires simple base form 'take'.",
    subtopic: "Verb"
  },
  {
    num: 21,
    stem: "He told (A)[to me] that he (B)[would be] traveling to Singapore on business (C)[the following] (D)[week].",
    options: [
      { key: "A", text: "to me", is_correct: true },
      { key: "B", text: "would be", is_correct: false },
      { key: "C", text: "the following", is_correct: false },
      { key: "D", text: "week", is_correct: false }
    ],
    explanation: "(A) should be 'me'. The verb 'tell' takes a direct personal object without preposition: [tell + person].",
    subtopic: "Verb"
  },
  {
    num: 22,
    stem: "Hardly (A)[had he arrived] at the terminal (B)[than] the announcement (C)[was made] that his flight was (D)[canceled].",
    options: [
      { key: "A", text: "had he arrived", is_correct: false },
      { key: "B", text: "than", is_correct: true },
      { key: "C", text: "was made", is_correct: false },
      { key: "D", text: "canceled", is_correct: false }
    ],
    explanation: "(B) should be 'when'. The correlative pair is [Hardly ... when], whereas [No sooner ... than].",
    subtopic: "Conjunction & Linkers"
  },
  {
    num: 23,
    stem: "Neither the manager (A)[or] the supervisors (B)[were] satisfied with the results of the quarterly (C)[financial] (D)[audit].",
    options: [
      { key: "A", text: "or", is_correct: true },
      { key: "B", text: "were", is_correct: false },
      { key: "C", text: "financial", is_correct: false },
      { key: "D", text: "audit", is_correct: false }
    ],
    explanation: "(A) should be 'nor'. The correlative partner for 'neither' is always 'nor' (Neither ... nor).",
    subtopic: "Conjunction & Linkers"
  },
  {
    num: 24,
    stem: "The director (A)[asked] that all department heads (B)[submits] their annual budgets (C)[by] Friday (D)[afternoon].",
    options: [
      { key: "A", text: "asked", is_correct: false },
      { key: "B", text: "submits", is_correct: true },
      { key: "C", text: "by", is_correct: false },
      { key: "D", text: "afternoon", is_correct: false }
    ],
    explanation: "(B) should be 'submit'. Subjunctive after 'ask that' requires simple bare verb.",
    subtopic: "Verb"
  },
  {
    num: 25,
    stem: "The committee has already decided (A)[on the matter], so there is (B)[no point] to discuss (C)[it] any (D)[further].",
    options: [
      { key: "A", text: "on the matter", is_correct: false },
      { key: "B", text: "no point to discuss", is_correct: true },
      { key: "C", text: "it", is_correct: false },
      { key: "D", text: "further", is_correct: false }
    ],
    explanation: "(B) should be 'no point in discussing'. The idiom is [there is no point in + gerund].",
    subtopic: "Verb"
  },
  {
    num: 26,
    stem: "Scarcely (A)[the train had pulled] into the station (B)[when] the passengers rushed (C)[to board] the crowded (D)[compartments].",
    options: [
      { key: "A", text: "the train had pulled", is_correct: true },
      { key: "B", text: "when", is_correct: false },
      { key: "C", text: "to board", is_correct: false },
      { key: "D", text: "compartments", is_correct: false }
    ],
    explanation: "(A) should be 'had the train pulled'. Negative adverbial 'Scarcely' at sentence opening requires subject-auxiliary inversion.",
    subtopic: "Inversion"
  },
  {
    num: 27,
    stem: "She would rather (A)[that you do not] mention (B)[the incident] to anyone until the formal investigation (C)[is] (D)[completed].",
    options: [
      { key: "A", text: "that you do not", is_correct: true },
      { key: "B", text: "the incident", is_correct: false },
      { key: "C", text: "is", is_correct: false },
      { key: "D", text: "completed", is_correct: false }
    ],
    explanation: "(A) should be 'that you did not'. 'Would rather that' with a different subject requires past subjunctive.",
    subtopic: "Verb"
  },
  {
    num: 28,
    stem: "Had the rescue team (A)[arrived] an hour earlier, they (B)[could save] the hikers who (C)[were trapped] on the (D)[mountain].",
    options: [
      { key: "A", text: "arrived", is_correct: false },
      { key: "B", text: "could save", is_correct: true },
      { key: "C", text: "were trapped", is_correct: false },
      { key: "D", text: "mountain", is_correct: false }
    ],
    explanation: "(B) should be 'could have saved'. Inverted third conditional [Had + subject + past participle] requires [could have + past participle] in main clause.",
    subtopic: "Tenses"
  },
  {
    num: 29,
    stem: "Each of the participants (A)[in the workshop] (B)[are required] to bring (C)[their own] laptop (D)[and notebook].",
    options: [
      { key: "A", text: "in the workshop", is_correct: false },
      { key: "B", text: "are required", is_correct: true },
      { key: "C", text: "their own", is_correct: false },
      { key: "D", text: "and notebook", is_correct: false }
    ],
    explanation: "(B) should be 'is required'. The indefinite pronoun 'Each' takes a singular verb.",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 30,
    stem: "She has lived in Chittagong (A)[since] five years, but she (B)[is planning] to move (C)[to Dhaka] early (D)[next spring].",
    options: [
      { key: "A", text: "since", is_correct: true },
      { key: "B", text: "is planning", is_correct: false },
      { key: "C", text: "to move", is_correct: false },
      { key: "D", text: "next spring", is_correct: false }
    ],
    explanation: "(A) should be 'for'. Use 'for' with duration/period of time ('five years'); 'since' is for a specific point in time.",
    subtopic: "Prepositions"
  },
  {
    num: 31,
    stem: "Despite (A)[of the heavy rain], the football match proceeded as (B)[scheduled] in front of (C)[thousands of] enthusiastic (D)[spectators].",
    options: [
      { key: "A", text: "of the heavy rain", is_correct: true },
      { key: "B", text: "scheduled", is_correct: false },
      { key: "C", text: "thousands of", is_correct: false },
      { key: "D", text: "spectators", is_correct: false }
    ],
    explanation: "(A) should be 'the heavy rain'. 'Despite' does not take 'of'; 'in spite of' takes 'of'.",
    subtopic: "Prepositions"
  },
  {
    num: 32,
    stem: "The number of qualified applicants for the scholarship (A)[have increased] (B)[substantially] compared (C)[to] that of (D)[last year].",
    options: [
      { key: "A", text: "have increased", is_correct: true },
      { key: "B", text: "substantially", is_correct: false },
      { key: "C", text: "to", is_correct: false },
      { key: "D", text: "last year", is_correct: false }
    ],
    explanation: "(A) should be 'has increased'. 'The number of' takes a singular verb; 'A number of' takes plural.",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 33,
    stem: "He prevented the child (A)[to cross] the busy highway without (B)[looking] both ways (C)[for approaching] (D)[traffic].",
    options: [
      { key: "A", text: "to cross", is_correct: true },
      { key: "B", text: "looking", is_correct: false },
      { key: "C", text: "for approaching", is_correct: false },
      { key: "D", text: "traffic", is_correct: false }
    ],
    explanation: "(A) should be 'from crossing'. The verb 'prevent' governs the preposition [prevent + object + from + gerund].",
    subtopic: "Verb"
  },
  {
    num: 34,
    stem: "I look forward (A)[to meet] you (B)[in person] when you arrive (C)[at the airport] next (D)[Monday].",
    options: [
      { key: "A", text: "to meet", is_correct: true },
      { key: "B", text: "in person", is_correct: false },
      { key: "C", text: "at the airport", is_correct: false },
      { key: "D", text: "Monday", is_correct: false }
    ],
    explanation: "(A) should be 'to meeting'. In the phrasal verb 'look forward to', 'to' is a preposition requiring a gerund.",
    subtopic: "Verb"
  },
  {
    num: 35,
    stem: "The climate of Bogura is similar (A)[to] Rajshahi, but its winter temperatures (B)[are often] slightly (C)[lower] on (D)[average].",
    options: [
      { key: "A", text: "to Rajshahi", is_correct: true },
      { key: "B", text: "are often", is_correct: false },
      { key: "C", text: "lower", is_correct: false },
      { key: "D", text: "average", is_correct: false }
    ],
    explanation: "(A) should be 'to that of Rajshahi'. Avoid illogical comparison: compare climate with climate, not climate with city.",
    subtopic: "Comparison of Adjective & Adverb"
  },
  {
    num: 36,
    stem: "Neither my parents (A)[nor] my elder brother (B)[were] aware that I had entered (C)[the national chess] (D)[championship].",
    options: [
      { key: "A", text: "nor", is_correct: false },
      { key: "B", text: "were", is_correct: true },
      { key: "C", text: "the national chess", is_correct: false },
      { key: "D", text: "championship", is_correct: false }
    ],
    explanation: "(B) should be 'was'. In 'neither... nor', the verb agrees with the closer subject ('brother', singular).",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 37,
    stem: "One of the most significant (A)[challenge] facing modern urban planning is the (B)[efficient] disposal (C)[of solid] (D)[waste].",
    options: [
      { key: "A", text: "challenge", is_correct: true },
      { key: "B", text: "efficient", is_correct: false },
      { key: "C", text: "of solid", is_correct: false },
      { key: "D", text: "waste", is_correct: false }
    ],
    explanation: "(A) should be 'challenges'. The structure 'One of the + superlative' requires a plural noun.",
    subtopic: "Noun"
  },
  {
    num: 38,
    stem: "She is accustomed (A)[to wake] up at dawn (B)[every morning] to practice (C)[the piano] before (D)[breakfast].",
    options: [
      { key: "A", text: "to wake", is_correct: true },
      { key: "B", text: "every morning", is_correct: false },
      { key: "C", text: "the piano", is_correct: false },
      { key: "D", text: "breakfast", is_correct: false }
    ],
    explanation: "(A) should be 'to waking'. The expression 'be accustomed to' contains a preposition 'to', requiring a gerund.",
    subtopic: "Verb"
  },
  {
    num: 39,
    stem: "If you had informed us (A)[in advance], we (B)[would provide] private transportation from the hotel (C)[to the venue] (D)[promptly].",
    options: [
      { key: "A", text: "in advance", is_correct: false },
      { key: "B", text: "would provide", is_correct: true },
      { key: "C", text: "to the venue", is_correct: false },
      { key: "D", text: "promptly", is_correct: false }
    ],
    explanation: "(B) should be 'would have provided'. Third conditional formula: [If + past perfect, would have + past participle].",
    subtopic: "Tenses"
  },
  {
    num: 40,
    stem: "He did not let anyone (A)[to know] that he was contemplating (B)[resigning] from his position (C)[as general] (D)[counsel].",
    options: [
      { key: "A", text: "to know", is_correct: true },
      { key: "B", text: "resigning", is_correct: false },
      { key: "C", text: "as general", is_correct: false },
      { key: "D", text: "counsel", is_correct: false }
    ],
    explanation: "(A) should be 'know'. Causative verb 'let' takes a bare infinitive without 'to': [let + object + bare verb].",
    subtopic: "Verb"
  },
  {
    num: 41,
    stem: "The committee requested that the auditor (A)[submits] an interim report (B)[prior to] the board's (C)[regularly] scheduled (D)[assembly].",
    options: [
      { key: "A", text: "submits", is_correct: true },
      { key: "B", text: "prior to", is_correct: false },
      { key: "C", text: "regularly", is_correct: false },
      { key: "D", text: "assembly", is_correct: false }
    ],
    explanation: "(A) should be 'submit'. Subjunctive after 'request that' requires simple base form 'submit'.",
    subtopic: "Verb"
  },
  {
    num: 42,
    stem: "No sooner (A)[had the bell rung] (B)[when] the students packed up (C)[their books] and hurried out (D)[into the hallway].",
    options: [
      { key: "A", text: "had the bell rung", is_correct: false },
      { key: "B", text: "when", is_correct: true },
      { key: "C", text: "their books", is_correct: false },
      { key: "D", text: "into the hallway", is_correct: false }
    ],
    explanation: "(B) should be 'than'. Correlative pair is [No sooner ... than].",
    subtopic: "Conjunction & Linkers"
  },
  {
    num: 43,
    stem: "He made his younger brother (A)[to apologize] for breaking (B)[the neighbour's] window with (C)[his] cricket (D)[ball].",
    options: [
      { key: "A", text: "to apologize", is_correct: true },
      { key: "B", text: "the neighbour's", is_correct: false },
      { key: "C", text: "his", is_correct: false },
      { key: "D", text: "ball", is_correct: false }
    ],
    explanation: "(A) should be 'apologize'. Active causative verb 'make' requires a bare infinitive without 'to': [make + person + bare verb].",
    subtopic: "Verb"
  },
  {
    num: 44,
    stem: "Physics (A)[are] considered by many high school seniors (B)[to be] one of the (C)[most challenging] subjects on (D)[the curriculum].",
    options: [
      { key: "A", text: "are", is_correct: true },
      { key: "B", text: "to be", is_correct: false },
      { key: "C", text: "most challenging", is_correct: false },
      { key: "D", text: "the curriculum", is_correct: false }
    ],
    explanation: "(A) should be 'is'. Academic disciplines ending in -ics (Physics, Mathematics, Economics) take singular verbs.",
    subtopic: "Subject Verb Agreement"
  },
  {
    num: 45,
    stem: "She had rather (A)[taking] the express train than the local bus (B)[because] it is far (C)[more reliable] in (D)[peak hours].",
    options: [
      { key: "A", text: "taking", is_correct: true },
      { key: "B", text: "because", is_correct: false },
      { key: "C", text: "more reliable", is_correct: false },
      { key: "D", text: "peak hours", is_correct: false }
    ],
    explanation: "(A) should be 'take'. 'Would rather' / 'Had rather' takes the bare infinitive [would rather + verb].",
    subtopic: "Verb"
  },
  {
    num: 46,
    stem: "The luggage (A)[were] misplaced by the airline staff (B)[during] our transit (C)[through] the international (D)[hub].",
    options: [
      { key: "A", text: "were", is_correct: true },
      { key: "B", text: "during", is_correct: false },
      { key: "C", text: "through", is_correct: false },
      { key: "D", text: "hub", is_correct: false }
    ],
    explanation: "(A) should be 'was'. 'Luggage' is non-count uncountable and takes singular 'was'.",
    subtopic: "Noun"
  },
  {
    num: 47,
    stem: "They succeeded (A)[in win] the championship trophy (B)[after] practicing rigorously for (C)[several] consecutive (D)[months].",
    options: [
      { key: "A", text: "in win", is_correct: true },
      { key: "B", text: "after", is_correct: false },
      { key: "C", text: "several", is_correct: false },
      { key: "D", text: "months", is_correct: false }
    ],
    explanation: "(A) should be 'in winning'. Preposition 'in' governs the gerund 'winning': [succeed in + gerund].",
    subtopic: "Verb"
  },
  {
    num: 48,
    stem: "The furniture in the newly opened showroom (A)[are] imported (B)[directly] from master craftsmen (C)[in] Northern (D)[Italy].",
    options: [
      { key: "A", text: "are", is_correct: true },
      { key: "B", text: "directly", is_correct: false },
      { key: "C", text: "in", is_correct: false },
      { key: "D", text: "Italy", is_correct: false }
    ],
    explanation: "(A) should be 'is'. 'Furniture' is an uncountable noun and always takes a singular verb.",
    subtopic: "Noun"
  },
  {
    num: 49,
    stem: "He was accused (A)[for stealing] the confidential research dossier (B)[from] the head scientist's (C)[private] (D)[office].",
    options: [
      { key: "A", text: "for stealing", is_correct: true },
      { key: "B", text: "from", is_correct: false },
      { key: "C", text: "private", is_correct: false },
      { key: "D", text: "office", is_correct: false }
    ],
    explanation: "(A) should be 'of stealing'. The correct preposition collocation is [accused of + gerund], not 'accused for'.",
    subtopic: "Prepositions"
  },
  {
    num: 50,
    stem: "Neither the captain nor the crew members (A)[was] able (B)[to identify] the mysterious distress signal (C)[emanating from] the deep (D)[ocean trench].",
    options: [
      { key: "A", text: "was", is_correct: true },
      { key: "B", text: "to identify", is_correct: false },
      { key: "C", text: "emanating from", is_correct: false },
      { key: "D", text: "ocean trench", is_correct: false }
    ],
    explanation: "(A) should be 'were'. In 'neither... nor', the verb agrees with the closer subject ('crew members', plural).",
    subtopic: "Subject Verb Agreement"
  }
];

async function run() {
  const client = await pool.connect();
  try {
    console.log('Ingesting authentic Cliffs TOEFL Mini-Tests into PostgreSQL...');

    // Subtopics map
    const subtopicsRes = await client.query('SELECT id, name, slug FROM academic_subtopics WHERE topic_id = $1', [GRAMMAR_TOPIC_ID]);
    const subtopicMap = new Map();
    for (const row of subtopicsRes.rows) {
      subtopicMap.set(row.name.toLowerCase(), row.id);
      subtopicMap.set(row.slug.toLowerCase(), row.id);
    }

    const allTests = [
      {
        slug: 'cliffs_toefl_mini_test_01',
        title: 'NSU Admission Special - Cliffs TOEFL Grammar Mini-Test 01',
        description: 'Authentic 50-item Error Identification Mini-Test directly from Cliffs TOEFL (Part III: Grammar Items 3-14), modeled for NSU English Section.',
        questions: miniTest1
      },
      {
        slug: 'cliffs_toefl_mini_test_02',
        title: 'NSU Admission Special - Cliffs TOEFL Grammar Mini-Test 02',
        description: 'Authentic 50-item Error Identification Mini-Test directly from Cliffs TOEFL (Part III: Grammar Items 15-20), modeled for NSU English Section.',
        questions: miniTest2
      }
    ];

    let totalInsertedQs = 0;

    for (const t of allTests) {
      console.log(`\nProcessing ${t.title}...`);
      const examId = toDeterministicUuid(`exam_${t.slug}`);

      // Upsert Exam
      await client.query(`
        INSERT INTO exams (
          id, title, track, exam_type, duration_seconds,
          total_marks, negative_mark_per_question, is_active, target_university_id
        ) VALUES ($1, $2, 'NSU', 'section_exam', 1500, 50.0, 0.0, true, $3)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          target_university_id = EXCLUDED.target_university_id,
          total_marks = EXCLUDED.total_marks
      `, [examId, t.title, NSU_UNI_ID]);

      const questionLinkPlaceholders = [];
      const questionLinkValues = [];

      for (let i = 0; i < t.questions.length; i++) {
        const item = t.questions[i];
        const subtopicId = subtopicMap.get(item.subtopic.toLowerCase()) || subtopicMap.get('sentence_structure') || null;

        const optionsArray = item.options.map(o => ({
          id: crypto.randomUUID(),
          text: o.text,
          is_correct: o.is_correct,
          key_original: o.key
        }));

        const hash = hashContent(item.stem, optionsArray);
        const qId = toDeterministicUuid(`toefl_q_${hash}`);

        // Insert question
        const qInsertRes = await client.query(`
          INSERT INTO questions (
            id, item_type, subject_id, topic_id, subtopic_id,
            stem_primary, options, solution_markdown, difficulty_rating,
            is_active, content_hash
          ) VALUES ($1, 'mcq_standalone', $2, $3, $4, $5, $6, $7, 3.00, true, $8)
          ON CONFLICT (content_hash) DO UPDATE SET
            solution_markdown = EXCLUDED.solution_markdown
          RETURNING id
        `, [
          qId,
          ENGLISH_SUBJECT_ID,
          GRAMMAR_TOPIC_ID,
          subtopicId,
          item.stem,
          JSON.stringify(optionsArray),
          item.explanation,
          hash
        ]);

        const actualQId = qInsertRes.rows[0].id;
        totalInsertedQs++;

        // Insert appearance
        const appearanceId = toDeterministicUuid(`toefl_app_${actualQId}_${t.slug}`);
        await client.query(`
          INSERT INTO question_exam_appearances (
            id, question_id, university_id, exam_slug, exam_title, is_model_test,
            section_code, section_title, question_number, badge_label, academic_term
          ) VALUES ($1, $2, $3, $4, $5, false, 'english', 'Grammar & Vocabulary', $6, $7, 'Cliffs TOEFL')
          ON CONFLICT (id) DO NOTHING
        `, [
          appearanceId,
          actualQId,
          NSU_UNI_ID,
          t.slug,
          t.title,
          item.num,
          `Cliffs TOEFL [Q${item.num}]`
        ]);

        // Map to exam_questions
        const offset = i * 3;
        questionLinkPlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
        questionLinkValues.push(examId, actualQId, item.num);
      }

      // Batch insert exam_questions
      await client.query(`
        INSERT INTO exam_questions (exam_id, question_id, question_order)
        VALUES ${questionLinkPlaceholders.join(', ')}
        ON CONFLICT (exam_id, question_id) DO NOTHING
      `, questionLinkValues);

      console.log(`Successfully mapped ${t.questions.length} questions to ${t.title}.`);
    }

    console.log(`\nAll TOEFL mini-tests ingested! Total question items handled: ${totalInsertedQs}`);

    const qCountRes = await client.query('SELECT count(*) FROM questions');
    console.log(`Total questions in database now: ${qCountRes.rows[0].count}`);

    const examCountRes = await client.query('SELECT count(*) FROM exams');
    console.log(`Total exams in database now: ${examCountRes.rows[0].count}`);

    const linkCountRes = await client.query('SELECT count(*) FROM exam_questions');
    console.log(`Total exam_questions links now: ${linkCountRes.rows[0].count}`);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(console.error);
