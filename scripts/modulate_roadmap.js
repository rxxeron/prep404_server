const fs = require('fs');

const path = 'lib/features/practice_map/presentation/screens/admission_hiking_roadmap_screen.dart';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split(/\r?\n/);

// 1. Add imports
const importIdx = lines.findIndex(l => l.includes('horizon_picker_sheet.dart'));
lines.splice(importIdx + 1, 0,
  "import '../widgets/roadmap_hud_bar.dart';",
  "import '../widgets/roadmap_summit_gate.dart';",
  "import '../widgets/roadmap_milestone_node.dart';"
);

// 2. Replace the HUD calls inside Column
const topBarIdx = lines.findIndex(l => l.includes('_buildTopSelectorBar(journey)'));
const pillarFilterIdx = lines.findIndex(l => l.includes('_buildPillarFilterBar(allItems)'));

const newHudCalls = [
'                // 1. Sleek Compact Top Bar (University & Track + Horizon Switchers)',
'                RoadmapTopSelectorBar(',
'                  journey: journey,',
'                  activeUniversityKey: _activeUniversityKey,',
'                  activeTrack: _activeTrack,',
'                  formatTrackName: _formatTrackName,',
'                  onTapUniversity: () => _showUniversityTrackPicker(context, journey),',
'                  onTapHorizon: () => _showHorizonPicker(context, journey),',
'                  colorCardPlum: colorCardPlum,',
'                  colorPlumBorder: colorPlumBorder,',
'                  colorCream: colorCream,',
'                  colorTangerine: colorTangerine,',
'                  colorSunshine: colorSunshine,',
'                ),',
'',
'                // 2. Gamified Quest HUD Bar (Streak, XP, Stars, Countdown, Progress)',
'                RoadmapGamifiedHudCard(',
'                  journey: journey,',
'                  allItems: allItems,',
'                  completedCount: completedCount,',
'                  progressPercent: progressPercent,',
'                  colorCardPlum: colorCardPlum,',
'                  colorPlumBorder: colorPlumBorder,',
'                  colorCream: colorCream,',
'                  colorTangerine: colorTangerine,',
'                  colorSunshine: colorSunshine,',
'                ),',
'',
'                // 3. Compact Pillar Filter Tabs (All, Topic, Subject, Section, Mock)',
'                RoadmapPillarFilterBar(',
'                  allItems: allItems,',
'                  selectedPillar: _selectedPillar,',
'                  onSelectPillar: (pillar) => setState(() => _selectedPillar = pillar),',
'                  colorTangerine: colorTangerine,',
'                  colorCardPlum: colorCardPlum,',
'                  colorCream: colorCream,',
'                  colorPlumBorder: colorPlumBorder,',
'                ),'
];

lines.splice(topBarIdx - 1, (pillarFilterIdx - (topBarIdx - 1)) + 1, ...newHudCalls);

// 3. Find start of _buildTopSelectorBar definition
const defTopBarIdx = lines.findIndex(l => l.includes('Widget _buildTopSelectorBar('));
// Find start of _buildGamifiedMilestoneMap
const mapIdx = lines.findIndex(l => l.includes('Widget _buildGamifiedMilestoneMap('));

// Remove _buildTopSelectorBar through to mapIdx - 1
// (which includes _buildTopSelectorBar, _buildGamifiedHudCard, _buildHudBadge, _buildPillarFilterBar, _buildFilterPill)
lines.splice(defTopBarIdx - 1, (mapIdx - defTopBarIdx) + 1);

// Now in _buildGamifiedMilestoneMap:
// Replace _buildMilestoneRow and _buildSummitGate calls inside it
const newMapIdx = lines.findIndex(l => l.includes('Widget _buildGamifiedMilestoneMap('));
const milestoneRowCallIdx = lines.findIndex(l => l.includes('_buildMilestoneRow('));
const summitGateCallIdx = lines.findIndex(l => l.includes('_buildSummitGate('));

// Find modalDetailsIdx:
const modalDetailsIdx = lines.findIndex(l => l.includes('void _showMilestoneDetailsModal('));

// Replace from milestoneRowCallIdx - 1 to summitGateCallIdx + 3
const newMilestoneMapBody = [
'              // 2. The Milestone Nodes and Interactive Attached Cards',
'              for (int i = 0; i < items.length; i++) ...[',
'                RoadmapMilestoneNode(',
'                  index: i + 1,',
'                  item: items[i],',
'                  nodeCenter: nodePositions[i],',
'                  isCompleted: items[i].isCompleted,',
'                  isCurrent: i == currentIndex,',
'                  isLocked: i > currentIndex,',
'                  screenWidth: screenWidth,',
'                  tokenRadius: tokenRadius,',
'                  pulseAnimation: _pulseController,',
'                  pillarColor: _getPillarColor(items[i].pillar),',
'                  pillarBadgeLabel: _getPillarBadgeLabel(items[i].pillar),',
'                  pillarIcon: _getPillarIcon(items[i].pillar),',
'                  colorTangerine: colorTangerine,',
'                  colorSunshine: colorSunshine,',
'                  colorCardPlum: colorCardPlum,',
'                  colorPlumBorder: colorPlumBorder,',
'                  colorCream: colorCream,',
'                  onTap: () => _showMilestoneDetailsModal(',
'                    context,',
'                    items[i],',
'                    i + 1,',
'                    i > currentIndex,',
'                    items[i].isCompleted,',
'                  ),',
'                ),',
'              ],',
'',
'              // 3. The Grand Admission Gate Summit (At Path Completion)',
'              Positioned(',
'                top: summitY - 40,',
'                left: 16,',
'                right: 16,',
'                child: RoadmapSummitGate(',
'                  journey: journey,',
'                  completedCount: items.where((i) => i.isCompleted).length,',
'                  totalCount: items.length,',
'                  colorSunshine: colorSunshine,',
'                  colorTangerine: colorTangerine,',
'                  colorCream: colorCream,',
'                  onConquerFinal: (finalTest) => _launchExam(context, finalTest),',
'                ),',
'              ),'
];

// Let's find end of the map method (the closing brace before _buildMilestoneRow)
const milestoneRowDefIdx = lines.findIndex(l => l.includes('Widget _buildMilestoneRow('));

// We replace inside the Stack:
const stackChildrenIdx = lines.findIndex(l => l.includes('// 2. The Milestone Nodes and Interactive Attached Cards'));
const summitPosIdx = lines.findIndex(l => l.includes('// 3. The Grand Admission Gate Summit (At Path Completion)'));
// find the end of the summit Positioned:
let summitEndIdx = summitPosIdx;
while (summitEndIdx < lines.length && !lines[summitEndIdx].includes('),')) {
  summitEndIdx++;
}
summitEndIdx++; // include the closing '), '

lines.splice(stackChildrenIdx, (summitEndIdx - stackChildrenIdx) + 1, ...newMilestoneMapBody);

// Now remove all methods after _buildGamifiedMilestoneMap up to _showMilestoneDetailsModal:
// specifically: _buildMilestoneRow, _buildMilestoneToken, _buildSummitGate
const newMilestoneRowDefIdx = lines.findIndex(l => l.includes('Widget _buildMilestoneRow('));
const newModalDetailsIdx = lines.findIndex(l => l.includes('void _showMilestoneDetailsModal('));

lines.splice(newMilestoneRowDefIdx - 1, (newModalDetailsIdx - (newMilestoneRowDefIdx - 1)));

fs.writeFileSync(path, lines.join('\n') + '\n', 'utf8');
console.log('Successfully modulated admission_hiking_roadmap_screen.dart to line count:', lines.length);
