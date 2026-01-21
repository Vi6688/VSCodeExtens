import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {

	// Create a sidebar tree view item container
	const provider = new SidebarProvider(context);
	vscode.window.registerTreeDataProvider('CustomCMakeSidebar', provider);
	console.log("Custom cmak externsion");
	context.subscriptions.push(
		vscode.commands.registerCommand('CustomCMake.selectSystem', () => provider.selectSystem()),
		vscode.commands.registerCommand('CustomCMake.selectConfigure', () => provider.selectConfigure()),
		vscode.commands.registerCommand('CustomCMake.selectBuild', () => provider.selectBuild()),
		vscode.commands.registerCommand('CustomCMake.build', () => provider.build()),
		vscode.commands.registerCommand('CustomCMake.configureBuild', () => provider.configureBuild()),
		vscode.commands.registerCommand('CustomCMake.selectUsername', () => provider.selectUsername()),
		vscode.commands.registerCommand('CustomCMake.selectHostname', () => provider.selectHostname()),
		vscode.commands.registerCommand('CustomCMake.transferValue', () => provider.enterTransfer()),
		vscode.commands.registerCommand('CustomCMake.transfer', () => provider.transfer()),
		vscode.commands.registerCommand('CustomCMake.runAction', () => provider.runAction())
	);
}

export function deactivate() { }

async function getCMakeTargets(): Promise<string[]> {
	try {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) return [];

		const workspacePath = workspaceFolders[0].uri.fsPath + '/build';

		const { stdout } = await execAsync('cmake --build . --target help', { cwd: workspacePath });

		const targets: string[] = [];
		const lines = stdout.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed && trimmed.startsWith('...')) {
				const target = trimmed.replace('... ', '');
				targets.push(target);
			}
		}

		return targets;
	} catch (err) {
		vscode.window.showErrorMessage('Failed to get CMake targets: ' + err);
		return [];
	}
}

class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {

	private _onDidChangeTreeData: vscode.EventEmitter<SidebarItem | undefined> = new vscode.EventEmitter<SidebarItem | undefined>();
	readonly onDidChangeTreeData: vscode.Event<SidebarItem | undefined> = this._onDidChangeTreeData.event;

	// These values will now be read from settings.json
	private system: string = '';
	private arrchitectureAndCmakeConfigureMap: { [key: string]: string } = {
		'build-aarch64': 'cmake ..',
	};
	private cmakeConfigureCommand: string = '';
	private configure: string = '';
	private buildName: string = '';
	private hostname: string = '';
	private transferNo: string[] = [];
	private username: string = '';
	private transferfolder: string = 'builds';
	private workspacePath: string = '';
	private terminal: vscode.Terminal = vscode.window.createTerminal(`Custom CMake`);

	constructor(private context: vscode.ExtensionContext) {
		this.loadConfiguration();
		vscode.workspace.onDidChangeConfiguration(() => {
			this.loadConfiguration();
			this.refresh();
		});
	}

	loadConfiguration() {
		const config = vscode.workspace.getConfiguration('CustomCMake');

		this.system = config.get<string>('system', 'build-aarch64');
		this.configure = config.get<string>('configure', 'Release');
		this.buildName = config.get<string>('build', 'Main');
		this.username = config.get<string>('username', 'user')
		this.transferfolder = config.get<string>('folder', 'builds');
		this.cmakeConfigureCommand = config.get<string>('configureCommand', 'cmake ..');
		const savedHostname = config.get<string>('hostname', 'hostname1');

		this.hostname = savedHostname;

		const savedTransfers = config.get<string[] | string>('transfer', ['103']);
		this.transferNo = Array.isArray(savedTransfers) ? savedTransfers : [savedTransfers];
		const workspaceFolders = vscode.workspace.workspaceFolders;
		this.workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
	}

	runShellCommand(command: string) {
		if (this.terminal.exitStatus !== undefined) {
			this.terminal = vscode.window.createTerminal(`Custom CMake`);
		}
		this.terminal.show();
		this.terminal.sendText(command);
	}

	changeToBuildDirectory() {
		this.runShellCommand(`cd ${this.workspacePath}/build`);
	}

	refresh() {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: SidebarItem): vscode.TreeItem {
		return element;
	}
	getChildren(): Thenable<SidebarItem[]> {
		const blueCircle = '🔹';
		const sectionSeparator = '────────────────────────────────';

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
			new SidebarItem(`${blueCircle} Username: ${this.username || 'None selected'}`,
				vscode.TreeItemCollapsibleState.None,
				{
					command: 'CustomCMake.selectUsername',
					title: 'Select Username'
				}
			),
			new SidebarItem(
				`${blueCircle} Hostname: ${this.hostname || 'None selected'}`,
				vscode.TreeItemCollapsibleState.None,
				{
					command: 'CustomCMake.selectHostname',
					title: 'Select Hostname'
				}
			),

			// TRANSFER NUMBER (multi-select)
			new SidebarItem(
				`${blueCircle} Transfer No(s): ${this.transferNo.length ? this.transferNo.join(', ') : 'None selected'}`,
				vscode.TreeItemCollapsibleState.None,
				{
					command: 'CustomCMake.transferValue',
					title: 'Select Transfer Number(s)'
				}
			),

			// RUN ACTION / TRANSFER BUTTON
			new SidebarItem(`${sectionSeparator}`, vscode.TreeItemCollapsibleState.None),

			new SidebarItem('▶️ CONFIGURE ', vscode.TreeItemCollapsibleState.None, {
				command: 'CustomCMake.configureBuild',
				title: 'Configure Build'
			}),
			new SidebarItem(`▶️ BUILD`, vscode.TreeItemCollapsibleState.None, {
				command: 'CustomCMake.build',
				title: 'Build'
			}),
			new SidebarItem(`▶️ TRANSFER`, vscode.TreeItemCollapsibleState.None, {
				command: 'CustomCMake.transfer',
				title: 'Transfer'
			}),
			new SidebarItem('▶️ BUILD AND TRANSFER', vscode.TreeItemCollapsibleState.None, {
				command: 'CustomCMake.runAction',
				title: 'Build and Transfer'
			}),
			new SidebarItem(`${sectionSeparator}`, vscode.TreeItemCollapsibleState.None),
		]);
	}

	async selectSystem() {
		const items = ['Linux', 'build-aarch64']; // could also read all systems from settings
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select System' });
		if (pick) { this.system = pick; }
		this.refresh();
	}
	async configureBuild() {
		const cmakeConfigureCommand = this.arrchitectureAndCmakeConfigureMap[this.system];
		if (this.cmakeConfigureCommand) {
			this.runShellCommand(`cd ${this.workspacePath}/build && ` + this.cmakeConfigureCommand);
			vscode.window.showInformationMessage(`Running CMake configure for system: ${this.system}`);
		} else {
			vscode.window.showErrorMessage(`No CMake configure command found for system: ${this.system}`);
		}
	}
	async selectConfigure() {
		const items = ['Debug', 'Release', 'Custom'];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select Configure' });
		if (pick) { this.configure = pick; }
		this.refresh();
	}

	async selectBuild() {
		const targets = await getCMakeTargets();
		const items = ['All', ...targets];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select Build' });
		if (pick) { this.buildName = pick; }
		this.refresh();
	}
	async selectUsername() {
		const items = this.username ? [this.username] : [];
		const pick = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select Username'
		});

		if (pick) { this.username = pick; }
		this.refresh();
	}
	async selectHostname() {
		const items = ['hostname1', 'hostname2', 'hostname3'].concat(this.hostname ? [this.hostname] : []);
		const pick = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select Hostname'
		});

		if (pick) { this.hostname = pick; }
		this.refresh();
	}


	async enterTransfer() {
		const config = vscode.workspace.getConfiguration('CustomCMake');
		const savedTransfers = config.get<string[] | string>('transfer', ['103']);
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
		this.changeToBuildDirectory();
		this.runShellCommand("cmake --build . --target " + this.buildName);
		vscode.window.showInformationMessage(
			`Running build and transfer for System: ${this.system}, Configure: ${this.configure}, Build: ${this.buildName}, Transfer: ${this.transferNo}`
		);
		this.refresh();
	}

	async transfer(build: boolean = false) {
		this.changeToBuildDirectory();
		const buildCommand = build ? `cmake --build . --target ${this.buildName} ` : '';
		if (build) {
			this.runShellCommand(buildCommand);
		}
		const { stdout } = await execAsync('find -name ' + this.buildName, { cwd: this.workspacePath + "/build/" });
		const targetPath: string[] = stdout.split('\n').filter(line => line.trim() !== '');

		if (targetPath.length === 0) {
			vscode.window.showErrorMessage(`Build target ${this.buildName} not found for transfer.`);
			return;
		}
		const transferCommand = `scp -P 15${this.transferNo[0]} ${targetPath[0]} ${this.username}@gigamesh.live:/home/${this.username}/${this.transferfolder}/`;
		this.runShellCommand(transferCommand);
		console.log("Transfer Command: ", transferCommand);
		vscode.window.showInformationMessage(
			`Transferring build ${this.buildName} to ${this.username}@${this.hostname} in folder ${this.transferfolder}`
		);
	}

	runAction() {
		this.transfer(true);
	}


}


class SidebarItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly command?: vscode.Command
	) {
		super(label, collapsibleState);
	}
}
