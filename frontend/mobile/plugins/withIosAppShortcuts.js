/**
 * Expo config plugin for Veil's read-only iOS App Shortcuts.
 *
 * The generated intents only open existing read-only screens. They never load
 * key material, create transactions, or bypass the passkey signing ceremony.
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const FILE_NAME = 'VeilAppShortcuts.swift';

const SHORTCUTS = [
  {
    type: 'balance',
    title: 'Show balance',
    route: 'dashboard',
    phrases: [
      'What is my balance?',
      'How much do I have?',
      'How much I get?',
      'Wetin be my balance?',
      'Show me my balance',
    ],
  },
  {
    type: 'price',
    title: 'Show XLM price',
    route: 'token/XLM',
    phrases: [
      'What is the XLM price?',
      'How much is XLM?',
      'Check the price of XLM',
      'How much is Lumens?',
    ],
  },
];

function swiftString(value) {
  return JSON.stringify(value);
}

function renderIntent(shortcut) {
  const intentName = shortcut.type === 'balance' ? 'ShowBalanceIntent' : 'ShowXlmPriceIntent';
  const phraseLines = shortcut.phrases
    .map((phrase) => `        ${swiftString(`${phrase} in \\(.applicationName)` )},`)
    .join('\n');

  return `
@available(iOS 16.0, *)
struct ${intentName}: AppIntent {
    static var title: LocalizedStringResource = ${swiftString(shortcut.title)}
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(URL(string: ${swiftString(`veil://${shortcut.route}`)})!))
    }
}

`;
}

function renderSwift(shortcuts = SHORTCUTS) {
  const appShortcuts = shortcuts
    .map((shortcut) => {
      const intentName = shortcut.type === 'balance' ? 'ShowBalanceIntent' : 'ShowXlmPriceIntent';
      const phrases = shortcut.phrases
        .map((phrase) => `            ${swiftString(`${phrase} in \\(.applicationName)` )},`)
        .join('\n');
      return `        AppShortcut(
            intent: ${intentName}(),
            phrases: [
${phrases}
            ],
            shortTitle: ${swiftString(shortcut.title)},
            systemImageName: ${swiftString(shortcut.type === 'balance' ? 'chart.bar' : 'chart.line.uptrend.xyaxis')}
        )`;
    })
    .join(',\n');

  return `import AppIntents

@available(iOS 16.0, *)
struct VeilAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        [
${appShortcuts}
        ]
    }
}
${shortcuts.map(renderIntent).join('')}`;
}

function withIosAppShortcuts(config) {
  config = withDangerousMod(config, [
    'ios',
    (current) => {
      const projectRoot = current.modRequest.platformProjectRoot;
      const projectName = current.modRequest.projectName;
      const directory = path.join(projectRoot, projectName);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, FILE_NAME), renderSwift());
      return current;
    },
  ]);

  return withXcodeProject(config, (current) => {
    const project = current.modResults;
    const projectName = current.modRequest.projectName;
    const relativePath = `${projectName}/${FILE_NAME}`;
    const alreadyAdded = Object.values(project.pbxFileReferenceSection()).some(
      (file) => file.path === `"${relativePath}"` || file.path === relativePath,
    );
    if (!alreadyAdded) {
      project.addSourceFile(relativePath, { target: project.getFirstTarget().uuid });
    }
    return current;
  });
}

module.exports = withIosAppShortcuts;
module.exports.renderSwift = renderSwift;
module.exports.SHORTCUTS = SHORTCUTS;
