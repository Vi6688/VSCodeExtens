"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
function activate(context) {
    // Create a sidebar tree view item container
    const provider = new SidebarProvider(context);
    vscode.window.registerTreeDataProvider('CustomCMakeSidebar', provider);
    context.subscriptions.push(vscode.commands.registerCommand('CustomCMake.selectSystem', () => provider.selectSystem()), vscode.commands.registerCommand('CustomCMake.selectConfigure', () => provider.selectConfigure()), vscode.commands.registerCommand('CustomCMake.selectBuild', () => provider.selectBuild()), vscode.commands.registerCommand('CustomCMake.build', () => provider.build()), vscode.commands.registerCommand('CustomCMake.selectHostname', () => provider.selectHostname()), vscode.commands.registerCommand('CustomCMake.transferValue', () => provider.enterTransfer()), vscode.commands.registerCommand('CustomCMake.transfer', () => provider.transfer()));
}
function deactivate() { }
// ---------------- CMake Targets ----------------
async function getCMakeTargets() {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return [];
        const workspacePath = workspaceFolders[0].uri.fsPath + '/build';
        const { stdout } = await execAsync('cmake --build . --target help', { cwd: workspacePath });
        const targets = [];
        const lines = stdout.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && trimmed.startsWith('...')) {
                const target = trimmed.replace('... ', '');
                targets.push(target);
            }
        }
        return targets;
    }
    catch (err) {
        vscode.window.showErrorMessage('Failed to get CMake targets: ' + err);
        return [];
    }
}
// ---------------- Sidebar Provider ----------------
class SidebarProvider {
    context;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    // These values will now be read from settings.json
    system;
    configure;
    buildName;
    hostname;
    transferNo;
    constructor(context) {
        this.context = context;
        const config = vscode.workspace.getConfiguration('CustomCMake');
        this.system = config.get('system', 'build-aarch64');
        this.configure = config.get('configure', 'Release');
        this.buildName = config.get('build', 'Main');
        const savedHostname = config.get('hostname', 'hostname1');
        this.hostname = savedHostname;
        const savedTransfers = config.get('transfer', ['103']);
        this.transferNo = Array.isArray(savedTransfers) ? savedTransfers : [savedTransfers];
    }
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const blueCircle = '🔹';
        const sectionSeparator = '────────────';
        return Promise.resolve([
            // Section Header: BUILD
            new SidebarItem(`${sectionSeparator}`, vscode.TreeItemCollapsibleState.None),
            new SidebarItem(`  BUILD SECTION  `, vscode.TreeItemCollapsibleState.None),
            new SidebarItem(`${sectionSeparator}`, vscode.TreeItemCollapsibleState.None),
            // SYSTEM
            new SidebarItem(`${blueCircle} Architecture: ${this.system}`, vscode.TreeItemCollapsibleState.None, {
                command: 'CustomCMake.selectSystem',
                title: 'Select System'
            }),
            // CONFIGURE
            new SidebarItem(`${blueCircle} Release Type: ${this.configure}`, vscode.TreeItemCollapsibleState.None, {
                command: 'CustomCMake.selectConfigure',
                title: 'Select Configure'
            }),
            // BUILD
            new SidebarItem(`${blueCircle} Build Target: ${this.buildName}`, vscode.TreeItemCollapsibleState.None, {
                command: 'CustomCMake.selectBuild',
                title: 'Select Build'
            }),
            // Spacer
            new SidebarItem(' ', vscode.TreeItemCollapsibleState.None),
            // Section Header: TRANSFER
            new SidebarItem(`${sectionSeparator}`, vscode.TreeItemCollapsibleState.None),
            new SidebarItem(`  TRANSFER SECTION  `, vscode.TreeItemCollapsibleState.None),
            new SidebarItem(`${sectionSeparator}`, vscode.TreeItemCollapsibleState.None),
            // HOSTNAME (single select)
            new SidebarItem(`${blueCircle} Hostname: ${this.hostname || 'None selected'}`, vscode.TreeItemCollapsibleState.None, {
                command: 'CustomCMake.selectHostname',
                title: 'Select Hostname'
            }),
            // TRANSFER NUMBER (multi-select)
            new SidebarItem(`${blueCircle} Transfer No(s): ${this.transferNo.length ? this.transferNo.join(', ') : 'None selected'}`, vscode.TreeItemCollapsibleState.None, {
                command: 'CustomCMake.transferValue',
                title: 'Select Transfer Number(s)'
            }),
            // RUN ACTION / TRANSFER BUTTON
            new SidebarItem(`▶️ Transfer`, vscode.TreeItemCollapsibleState.None, {
                command: 'CustomCMake.transfer',
                title: 'Transfer'
            }),
        ]);
    }
    // ---------------- QuickPick / Input Handlers ----------------
    async selectSystem() {
        const items = ['build-aarch64']; // could also read all systems from settings
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select System' });
        if (pick)
            this.system = pick;
        this.refresh();
    }
    async selectConfigure() {
        const items = ['Debug', 'Release', 'Custom'];
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select Configure' });
        if (pick)
            this.configure = pick;
        this.refresh();
    }
    async selectBuild() {
        const targets = await getCMakeTargets();
        const items = ['All', ...targets];
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select Build' });
        if (pick)
            this.buildName = pick;
        this.refresh();
    }
    async selectHostname() {
        const items = ['hostname1', 'hostname2', 'hostname3'];
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Hostname'
        });
        if (pick)
            this.hostname = pick;
        this.refresh();
    }
    async enterTransfer() {
        const config = vscode.workspace.getConfiguration('CustomCMake');
        const savedTransfers = config.get('transfer', ['103']);
        this.transferNo = Array.isArray(savedTransfers) ? savedTransfers : [savedTransfers];
        const items = this.transferNo; // example transfer numbers
        const picks = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Transfer Number(s)',
            canPickMany: true
        });
        this.transferNo = picks && picks.length > 0 ? picks : [];
        this.refresh();
    }
    async build() {
        this.refresh();
    }
    async transfer() {
        vscode.window.showInformationMessage(`System: ${this.system}, Configure: ${this.configure}, Build: ${this.buildName}, Transfer: ${this.transferNo}`);
    }
    runAction() {
        this.runShellCommand("ls -l");
        vscode.window.showInformationMessage(`System: ${this.system}, Configure: ${this.configure}, Build: ${this.buildName}, Transfer: ${this.transferNo}`);
    }
    runShellCommand(command) {
        const terminal = vscode.window.createTerminal(`Hello Tool`);
        terminal.show();
        terminal.sendText(command);
    }
}
class SidebarItem extends vscode.TreeItem {
    label;
    collapsibleState;
    command;
    constructor(label, collapsibleState, command) {
        super(label, collapsibleState);
        this.label = label;
        this.collapsibleState = collapsibleState;
        this.command = command;
    }
}
//# sourceMappingURL=extension.js.map