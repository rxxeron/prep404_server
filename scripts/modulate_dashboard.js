const fs = require('fs');

const path = 'lib/features/dashboard/presentation/screens/private_uni_dashboard_screen.dart';
const text = fs.readFileSync(path, 'utf8');
const lines = text.split(/\r?\n/);

// 1. Insert imports after PhoenixCompanionCard import
const pIdx = lines.findIndex(l => l.includes('phoenix_companion_card.dart'));
lines.splice(pIdx + 1, 0,
  "import '../widgets/dashboard_university_carousel.dart';",
  "import '../widgets/dashboard_today_test_card.dart';",
  "import '../widgets/dashboard_section_pattern_list.dart';"
);

// 2. Find start of section 1: '// 🌟 1. TARGET UNIVERSITY PREFERENCE SLIDER'
const sec1Start = lines.findIndex(l => l.includes('1. TARGET UNIVERSITY PREFERENCE SLIDER'));
// Find start of section 2: '// ⚡ 2. UNIVERSITY SPECIFIC DAILY EXAM ARENA CARD'
const sec2Start = lines.findIndex(l => l.includes('2. UNIVERSITY SPECIFIC DAILY EXAM ARENA CARD'));
// Find start of section 3: '// 🎯 3. UNIVERSITY QUESTION PATTERN SECTIONS'
const sec3Start = lines.findIndex(l => l.includes('3. UNIVERSITY QUESTION PATTERN SECTIONS'));
// Find start of section 4: '// ⚡ 4. LIVE 1v1 QUIZ DUEL BATTLE'
const sec4Start = lines.findIndex(l => l.includes('4. LIVE 1v1 QUIZ DUEL BATTLE'));

console.log({ sec1Start, sec2Start, sec3Start, sec4Start });

// Section 3 replacement (do from bottom up so line indices don't shift)
const sec3Replacement = [
'                // 3. UNIVERSITY QUESTION PATTERN SECTIONS',
'                DashboardSectionPatternList(',
'                  currentUni: currentUni,',
'                  onViewRoadmap: () => widget.onSwitchTab?.call(1),',
'                ),',
'                const SizedBox(height: 20),'
];
lines.splice(sec3Start, sec4Start - sec3Start, ...sec3Replacement);

// Re-find sec2Start and sec3Start
const newSec2Start = lines.findIndex(l => l.includes('2. UNIVERSITY SPECIFIC DAILY EXAM ARENA CARD'));
const newSec3Start = lines.findIndex(l => l.includes('3. UNIVERSITY QUESTION PATTERN SECTIONS'));

const sec2Replacement = [
'                // 2. UNIVERSITY SPECIFIC DAILY EXAM ARENA CARD (100% DATABASE-DRIVEN)',
'                DashboardTodayTestCard(',
'                  currentUni: currentUni,',
'                  dailyTestFuture: _dailyTestFuture,',
'                  remainingTimeLeft: _remainingLeft,',
'                  onLaunchExam: _launchTodayExam,',
'                ),',
'                const SizedBox(height: 20),'
];
lines.splice(newSec2Start, newSec3Start - newSec2Start, ...sec2Replacement);

// Re-find sec1Start and sec2Start
const finalSec1Start = lines.findIndex(l => l.includes('1. TARGET UNIVERSITY PREFERENCE SLIDER'));
const finalSec2Start = lines.findIndex(l => l.includes('2. UNIVERSITY SPECIFIC DAILY EXAM ARENA CARD'));

const sec1Replacement = [
'                // 1. TARGET UNIVERSITY PREFERENCE SLIDER / CAROUSEL',
'                DashboardUniversityCarousel(',
'                  universities: _service.getRoadmapsForTargets(',
'                      widget.profile.targetSelections.keys.toList()),',
'                  activeKey: activeKey,',
'                  onSelectUniversity: (key) => _service.setActiveUniversity(key),',
'                  onEditTargets: widget.onEditProfile != null',
'                      ? () => widget.onEditProfile!(2)',
'                      : null,',
'                  onViewRoadmap: () => widget.onSwitchTab?.call(1),',
'                ),',
'                const SizedBox(height: 18),'
];
lines.splice(finalSec1Start, finalSec2Start - finalSec1Start, ...sec1Replacement);

fs.writeFileSync(path, lines.join('\n') + '\n', 'utf8');
console.log('Successfully modulated private_uni_dashboard_screen.dart to line count:', lines.length);
