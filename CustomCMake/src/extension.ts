import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const CONFIG_SECTION = 'CustomCMake';
const TASK_TYPE = 'customcmake';
const TASK_SOURCE = 'Custom CMake';
const RUNNING_CONTEXT_KEY = 'customCMake.running';
// Used when no password has been stored with "Set Remote Password".
const DEFAULT_PASSWORD = 'Mission.Discover';
const PASSWORD_SECRET_KEY = 'CustomCMake.password';
const ALL_TARGET = 'All';
const PASSWORD_FILE_TTL_MS = 10 * 60 * 1000;
const ACTION_TRANSFER_INSTALL = 'Transfer and Install';
const ACTION_BUILD_TRANSFER = 'Build and Transfer';
const ACTION_BUILD_TRANSFER_INSTALL = 'Build, Transfer and Install';
const KEYRING_HINT = 'On Linux, VS Code needs a working keyring (see the README, Password section).';
const TERMINAL_CAPTURE_MS = 3000;
const STATUS_MESSAGE_MS = 8000;
const PACKAGE_TARGET_MARKER = 'installerpackage';
const CUSTOM_BUILD_TYPE = 'Custom';

interface RunningTask {
	name: string;
	execution: vscode.TaskExecution;
	startedAt: number;
	configures: boolean;
	cancelled: boolean;
}

type SectionId = 'build' | 'transfer' | 'actions';

interface Settings {
	system: string;
	configure: string;
	build: string;
	username: string;
	hostname: string;
	hostDomain: string;
	packagePattern: string;
	hostPrefix: string;
	transfer: string[];
	configureCommand: string;
	buildDirectory: string;
	jobs: number;
	saveBeforeBuild: boolean;
	systems: string[];
	hostnames: string[];
	transferOptions: string[];
}

export function activate(context: vscode.ExtensionContext) {
	const controller = new CustomCMakeController(context.extensionPath, context.secrets);
	const provider = new SidebarProvider(controller);
	const statusBar = new StatusBar(controller);
	const stopView = new StopViewProvider(controller);

	const register = (command: string, handler: () => unknown) =>
		vscode.commands.registerCommand(`${CONFIG_SECTION}.${command}`, handler);

	context.subscriptions.push(
		controller,
		provider,
		statusBar,
		stopView,
		vscode.window.registerWebviewViewProvider(StopViewProvider.viewType, stopView),
		vscode.window.registerTreeDataProvider('CustomCMakeSidebar', provider),
		register('selectSystem', () => controller.selectSystem()),
		register('selectConfigure', () => controller.selectConfigure()),
		register('selectBuild', () => controller.selectBuild()),
		register('selectJobs', () => controller.selectJobs()),
		register('selectUsername', () => controller.selectUsername()),
		register('selectHostname', () => controller.selectHostname()),
		register('transferValue', () => controller.selectTransfers()),
		register('configureBuild', () => controller.runConfigure()),
		register('build', () => controller.runBuild()),
		register('transfer', () => controller.runTransfer()),
		register('runAction', () => controller.runBuildAndTransfer()),
		register('transferInstall', () => controller.runTransferInstall()),
		register('runInstallAction', () => controller.runBuildTransferInstall()),
		register('setPassword', () => controller.setPassword()),
		register('clearPassword', () => controller.clearPassword()),
		register('clean', () => controller.runClean()),
		register('cancel', () => controller.cancel()),
		register('refreshTargets', () => controller.refreshTargets()),
		register('openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id} ${CONFIG_SECTION}`)),
	);
}

export function deactivate() { }

/** Wraps a value in single quotes so it is safe to paste into a POSIX shell. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(value => value.length > 0))];
}

class CustomCMakeController implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	private readonly disposables: vscode.Disposable[] = [];
	private running: RunningTask | undefined;
	// The terminal of the most recent task, so the next run can close it instead of piling up tabs.
	private taskTerminal: vscode.Terminal | undefined;
	private captureTerminalUntil = 0;
	private password: string | undefined;
	private cachedTargets: string[] | undefined;
	// Only set when a setting that affects configure changes; an existing CMakeCache.txt is trusted otherwise.
	private needsConfigure = false;

	constructor(private readonly extensionPath: string, private readonly secrets: vscode.SecretStorage) {
		secrets.get(PASSWORD_SECRET_KEY).then(value => {
			this.password = value;
			this.changeEmitter.fire();
		}, error => {
			vscode.window.showWarningMessage(`Custom CMake could not read the stored password: ${errorMessage(error)}. ${KEYRING_HINT}`);
		});
		void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false);
		this.disposables.push(
			this.changeEmitter,
			vscode.workspace.onDidChangeConfiguration(event => {
				if (!event.affectsConfiguration(CONFIG_SECTION)) { return; }
				const invalidatesConfigure = ['configure', 'configureCommand', 'system', 'buildDirectory']
					.some(key => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`));
				if (invalidatesConfigure) {
					this.needsConfigure = true;
					this.cachedTargets = undefined;
				}
				this.changeEmitter.fire();
			}),
			vscode.window.onDidOpenTerminal(terminal => {
				if (Date.now() < this.captureTerminalUntil) {
					this.taskTerminal = terminal;
					this.captureTerminalUntil = 0;
				}
			}),
			vscode.window.onDidCloseTerminal(terminal => {
				if (terminal === this.taskTerminal) { this.taskTerminal = undefined; }
			}),
			vscode.tasks.onDidEndTaskProcess(event => {
				if (event.execution === this.running?.execution) { this.finishRun(event.exitCode); }
			}),
			vscode.tasks.onDidEndTask(event => {
				if (event.execution === this.running?.execution) { this.finishRun(undefined); }
			}),
		);
	}

	dispose() {
		this.disposables.forEach(disposable => disposable.dispose());
	}

	// ---------------------------------------------------------------- state

	get settings(): Settings {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const transfer = config.get<string[] | string>('transfer', []);
		const selectedTransfers = Array.isArray(transfer) ? transfer : [transfer];
		return {
			system: config.get('system', 'build-aarch64'),
			configure: config.get('configure', 'Release'),
			build: config.get('build', 'Main'),
			username: config.get('username', ''),
			hostname: config.get('hostname', ''),
			hostDomain: config.get('hostDomain', ''),
			packagePattern: config.get('packagePattern', '*.ipk'),
			hostPrefix: config.get('hostPrefix', 'gigamesh'),
			transfer: selectedTransfers,
			configureCommand: config.get('configureCommand', 'cmake ..'),
			buildDirectory: config.get('buildDirectory', 'build'),
			jobs: config.get('jobs', 0),
			saveBeforeBuild: config.get('saveBeforeBuild', true),
			systems: config.get('systems', []),
			hostnames: config.get('hostnames', []),
			transferOptions: config.get('transferOptions', []),
		};
	}

	get workspacePath(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	}

	get buildPath(): string | undefined {
		const root = this.workspacePath;
		return root ? path.resolve(root, this.settings.buildDirectory) : undefined;
	}

	get remoteHost(): string {
		const { hostname, hostDomain } = this.settings;
		return hostname.includes('.') || !hostDomain ? hostname : `${hostname}.${hostDomain}`;
	}

	/** Parallel job count: the `jobs` setting, or one per CPU core when 0. */
	get jobCount(): number {
		const { jobs } = this.settings;
		return jobs > 0 ? jobs : Math.max(1, os.cpus().length);
	}

	get isConfigured(): boolean {
		const buildPath = this.buildPath;
		return !this.needsConfigure && !!buildPath && fs.existsSync(path.join(buildPath, 'CMakeCache.txt'));
	}

	private async update(key: keyof Settings, value: unknown) {
		const target = this.workspacePath
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
		await vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, target);
	}

	// ------------------------------------------------------------ selection

	private async pick(
		items: string[],
		current: string,
		title: string,
		allowCustom = false
	): Promise<string | undefined> {
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
		quickPick.title = title;
		quickPick.placeholder = allowCustom ? 'Pick a value or type a new one' : 'Pick a value';
		const baseItems = unique([...items, current]).map(label => ({
			label,
			description: label === current ? 'current' : undefined,
			iconPath: label === current ? new vscode.ThemeIcon('check') : undefined,
		}));
		quickPick.items = baseItems;
		quickPick.activeItems = baseItems.filter(item => item.label === current);

		if (allowCustom) {
			quickPick.onDidChangeValue(value => {
				const typed = value.trim();
				const exists = baseItems.some(item => item.label === typed);
				quickPick.items = typed && !exists
					? [{ label: typed, description: 'use this value', iconPath: new vscode.ThemeIcon('add') }, ...baseItems]
					: baseItems;
			});
		}

		return new Promise(resolve => {
			quickPick.onDidAccept(() => {
				resolve(quickPick.selectedItems[0]?.label);
				quickPick.hide();
			});
			quickPick.onDidHide(() => {
				resolve(undefined);
				quickPick.dispose();
			});
			quickPick.show();
		});
	}

	async selectSystem() {
		const { system, systems } = this.settings;
		const choice = await this.pick(systems, system, 'Select Architecture', true);
		if (choice) { await this.update('system', choice); }
	}

	async selectConfigure() {
		const { configure } = this.settings;
		const choice = await this.pick(['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel', CUSTOM_BUILD_TYPE], configure, 'Select Build Type');
		if (choice) { await this.update('configure', choice); }
	}

	async selectBuild() {
		const { build } = this.settings;
		const targets = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Reading CMake targets…' },
			() => this.getTargets()
		);
		const choice = await this.pick([ALL_TARGET, ...targets], build, 'Select Build Target');
		if (choice) { await this.update('build', choice); }
	}

	async selectJobs() {
		const { jobs } = this.settings;
		const value = await vscode.window.showInputBox({
			title: 'Build Threads',
			prompt: `Parallel build jobs. Enter 0 for auto (${os.cpus().length} CPU cores).`,
			value: String(jobs),
			validateInput: input => /^\d+$/.test(input.trim()) && Number(input) <= 1024
				? undefined
				: 'Enter a whole number from 0 to 1024',
		});
		if (value !== undefined) { await this.update('jobs', Number(value.trim())); }
	}

	async selectUsername() {
		const value = await vscode.window.showInputBox({
			title: 'Remote Username',
			prompt: 'User name used for scp',
			value: this.settings.username,
			validateInput: input => /\s/.test(input) ? 'Username cannot contain spaces' : undefined,
		});
		if (value !== undefined) { await this.update('username', value.trim()); }
	}

	async selectHostname() {
		const { hostname, hostnames } = this.settings;
		const choice = await this.pick(hostnames, hostname, 'Select Hostname', true);
		if (choice) { await this.update('hostname', choice); }
	}

	async selectTransfers() {
		const { transfer, transferOptions } = this.settings;
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
		quickPick.title = 'Select Transfer Target(s)';
		quickPick.placeholder = 'Pick targets, or type a port (15206), number (154), alias (bsnl154) or user@host';
		quickPick.canSelectMany = true;
		const describe = (label: string): vscode.QuickPickItem => {
			const target = this.resolveTarget(label);
			return { label, description: 'error' in target ? target.error : `-> ${target.label}` };
		};
		const baseItems = unique([...transferOptions, ...transfer]).map(describe);
		quickPick.items = baseItems;
		quickPick.selectedItems = baseItems.filter(item => transfer.includes(item.label));
		quickPick.onDidChangeValue(value => {
			const typed = value.trim();
			if (typed && !baseItems.some(item => item.label === typed)) {
				const extra = { ...describe(typed), iconPath: new vscode.ThemeIcon('add') };
				const keep = quickPick.selectedItems;
				quickPick.items = [extra, ...baseItems];
				quickPick.selectedItems = keep;
			}
		});
		const picks = await new Promise<readonly vscode.QuickPickItem[] | undefined>(resolve => {
			quickPick.onDidAccept(() => { resolve(quickPick.selectedItems); quickPick.hide(); });
			quickPick.onDidHide(() => { resolve(undefined); quickPick.dispose(); });
			quickPick.show();
		});
		if (picks) { await this.update('transfer', picks.map(item => item.label)); }
	}

	// -------------------------------------------------------------- targets

	async refreshTargets() {
		this.cachedTargets = undefined;
		const targets = await this.getTargets();
		vscode.window.showInformationMessage(`Found ${targets.length} CMake target(s).`);
	}

	private async getTargets(): Promise<string[]> {
		if (this.cachedTargets) { return this.cachedTargets; }
		const buildPath = this.buildPath;
		if (!buildPath || !fs.existsSync(buildPath)) {
			vscode.window.showWarningMessage('Build directory not found. Run Configure first.');
			return [];
		}
		try {
			const { stdout } = await execFileAsync('cmake', ['--build', '.', '--target', 'help'], { cwd: buildPath });
			const targets = stdout.split('\n')
				.map(line => line.trim())
				.filter(line => line.startsWith('... '))
				// "... name (the rest)" -> "name"
				.map(line => line.slice(4).replace(/\s*\(.*\)$/, '').trim())
				.filter(name => name.length > 0);
			this.cachedTargets = unique(targets);
			return this.cachedTargets;
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to read CMake targets: ${errorMessage(error)}`);
			return [];
		}
	}

	// -------------------------------------------------------------- actions

	get runningName(): string | undefined {
		return this.running?.name;
	}

	/**
	 * Runs the commands as a VS Code task: one shared panel, exit codes, compiler errors in the
	 * Problems panel, and only one run at a time.
	 */
	private async runTask(
		name: string,
		buildCommands: () => string[],
		options: { configures?: boolean; save?: boolean } = {}
	) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) { return; }
		if (this.running) {
			const choice = await vscode.window.showWarningMessage(
				`"${this.running.name}" is still running.`, 'Stop and Run', 'Keep Running');
			if (choice !== 'Stop and Run') { return; }
			await this.stopRunning();
		}
		if (options.save && this.settings.saveBeforeBuild) {
			await vscode.workspace.saveAll(false);
		}
		const task = new vscode.Task(
			{ type: TASK_TYPE },
			folder,
			name,
			TASK_SOURCE,
			new vscode.ShellExecution(buildCommands().join(' && '), { cwd: folder.uri.fsPath }),
			['$gcc']
		);
		task.presentationOptions = {
			reveal: vscode.TaskRevealKind.Always,
			panel: vscode.TaskPanelKind.Shared,
			clear: true,
			focus: false,
			showReuseMessage: false,
		};
		// Shared-panel reuse is unreliable, so close the previous run's terminal and track the new one.
		this.taskTerminal?.dispose();
		this.taskTerminal = undefined;
		this.captureTerminalUntil = Date.now() + TERMINAL_CAPTURE_MS;
		const execution = await vscode.tasks.executeTask(task);
		this.running = { name, execution, startedAt: Date.now(), configures: options.configures ?? false, cancelled: false };
		void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, true);
		this.changeEmitter.fire();
	}

	private finishRun(exitCode: number | undefined) {
		const run = this.running;
		if (!run) { return; }
		this.running = undefined;
		void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false);

		const seconds = ((Date.now() - run.startedAt) / 1000).toFixed(1);
		if (run.cancelled) {
			vscode.window.setStatusBarMessage(`$(circle-slash) ${run.name} stopped`, STATUS_MESSAGE_MS);
		} else if (exitCode === 0) {
			if (run.configures) {
				this.needsConfigure = false;
				this.cachedTargets = undefined;
			}
			vscode.window.setStatusBarMessage(`$(check) ${run.name} succeeded in ${seconds}s`, STATUS_MESSAGE_MS);
		} else {
			void vscode.window
				.showErrorMessage(`${run.name} failed${exitCode === undefined ? '' : ` (exit code ${exitCode})`} after ${seconds}s.`, 'Show Output')
				.then(choice => {
					if (choice) { void vscode.commands.executeCommand('workbench.action.terminal.focus'); }
				});
		}
		this.changeEmitter.fire();
	}

	private stopRunning(): Promise<void> {
		const run = this.running;
		if (!run) { return Promise.resolve(); }
		run.cancelled = true;
		return new Promise(resolve => {
			const subscription = vscode.tasks.onDidEndTask(event => {
				if (event.execution === run.execution) {
					subscription.dispose();
					resolve();
				}
			});
			run.execution.terminate();
		});
	}

	cancel() {
		return this.stopRunning();
	}

	/**
	 * Hands the stored password to transfer.sh through a short-lived 0600 file, so the command text
	 * and shell history only contain a path. The script deletes the file as soon as it has read it.
	 */
	private writePasswordFile(): string | undefined {
		const password = this.password ?? DEFAULT_PASSWORD;
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-cmake-'));
		const file = path.join(directory, 'pass');
		fs.writeFileSync(file, password, { mode: 0o600 });
		// Fallback cleanup in case the build fails before the script runs.
		setTimeout(() => fs.rmSync(directory, { recursive: true, force: true }), PASSWORD_FILE_TTL_MS).unref();
		return file;
	}

	private requireWorkspace(): string | undefined {
		const buildPath = this.buildPath;
		if (!buildPath) {
			vscode.window.showErrorMessage('Open a folder before using Custom CMake.');
		}
		return buildPath;
	}

	private configureCommands(buildPath: string): string[] {
		const { configureCommand, configure } = this.settings;
		const buildTypeFlag = configure === CUSTOM_BUILD_TYPE || /CMAKE_BUILD_TYPE/.test(configureCommand)
			? ''
			: ` -DCMAKE_BUILD_TYPE=${configure}`;
		return [
			`mkdir -p ${shellQuote(buildPath)}`,
			`cd ${shellQuote(buildPath)}`,
			`${configureCommand}${buildTypeFlag}`,
		];
	}

	private buildCommands(buildPath: string, targetOverride?: string): string[] {
		const build = targetOverride ?? this.settings.build;
		const targetArgs = build === ALL_TARGET ? '' : ` --target ${shellQuote(build)}`;
		const prefix = this.isConfigured
			? [`cd ${shellQuote(buildPath)}`]
			: this.configureCommands(buildPath);
		return [...prefix, `cmake --build .${targetArgs} --parallel ${this.jobCount}`];
	}

	async runConfigure() {
		const buildPath = this.requireWorkspace();
		if (!buildPath) { return; }
		await this.runTask('Configure', () => this.configureCommands(buildPath), { configures: true });
	}

	async runBuild() {
		const buildPath = this.requireWorkspace();
		if (!buildPath) { return; }
		await this.runTask('Build', () => this.buildCommands(buildPath), { configures: !this.isConfigured, save: true });
	}

	async runClean() {
		const buildPath = this.requireWorkspace();
		if (!buildPath) { return; }
		if (!fs.existsSync(buildPath)) {
			vscode.window.showInformationMessage('Nothing to clean.');
			return;
		}
		await this.runTask('Clean', () => [`cd ${shellQuote(buildPath)}`, 'cmake --build . --target clean']);
	}

	/** Turns a transfer entry into a "user@host|port" spec for scripts/transfer.sh. */
	resolveTarget(entry: string): { spec: string; label: string } | { error: string } {
		const { username, hostPrefix } = this.settings;
		const cleaned = entry.trim().replace(/:$/, '');
		if (cleaned.includes('@')) {
			return { spec: `${cleaned}|`, label: cleaned };
		}
		if (!username) { return { error: 'No username set.' }; }
		if (/^\d{5}$/.test(cleaned)) {
			if (!this.remoteHost) { return { error: `Entry ${cleaned} is a port but no hostname is set.` }; }
			return { spec: `${username}@${this.remoteHost}|${cleaned}`, label: `${this.remoteHost}:${cleaned}` };
		}
		const host = /^\d+$/.test(cleaned) ? `${hostPrefix}${cleaned}` : cleaned;
		return { spec: `${username}@${host}|`, label: host };
	}

	get isPackageTarget(): boolean {
		return this.settings.build.toLowerCase().includes(PACKAGE_TARGET_MARKER);
	}

	/** Validates the transfer and returns a factory, so the password file is only written when the run starts. */
	private transferInvocation(install: boolean): (() => string) | undefined {
		const { transfer, build, packagePattern } = this.settings;
		if (transfer.length === 0) {
			vscode.window.showErrorMessage('Cannot transfer: no transfer target selected.');
			return undefined;
		}
		if (build === ALL_TARGET) {
			vscode.window.showErrorMessage('Pick a specific build target to transfer (not "All").');
			return undefined;
		}
		if (install && !this.isPackageTarget) {
			vscode.window.showErrorMessage('Install is only available for InstallerPackage targets.');
			return undefined;
		}
		const specs: string[] = [];
		for (const entry of transfer) {
			const target = this.resolveTarget(entry);
			if ('error' in target) {
				vscode.window.showErrorMessage(`Cannot transfer: ${target.error}`);
				return undefined;
			}
			specs.push(target.spec);
		}
		const isPackage = this.isPackageTarget;
		const args = [
			isPackage ? 'package' : 'executable',
			isPackage ? packagePattern : build,
			install ? '1' : '0',
			...specs,
		].map(shellQuote);
		const scriptPath = path.join(this.extensionPath, 'scripts', 'transfer.sh');
		return () => {
			const passwordFile = this.writePasswordFile();
			const env = passwordFile ? `CUSTOM_CMAKE_PASSWORD_FILE=${shellQuote(passwordFile)} ` : '';
			return `${env}bash ${shellQuote(scriptPath)} ${args.join(' ')}`;
		};
	}

	async runTransfer(install = false) {
		const buildPath = this.requireWorkspace();
		const invocation = buildPath && this.transferInvocation(install);
		if (!buildPath || !invocation) { return; }
		await this.runTask(install ? ACTION_TRANSFER_INSTALL : 'Transfer', () => [`cd ${shellQuote(buildPath)}`, invocation()]);
	}

	runTransferInstall() {
		return this.runTransfer(true);
	}

	async runBuildAndTransfer(install = false) {
		const buildPath = this.requireWorkspace();
		const invocation = buildPath && this.transferInvocation(install);
		if (!buildPath || !invocation) { return; }
		await this.runTask(
			install ? ACTION_BUILD_TRANSFER_INSTALL : ACTION_BUILD_TRANSFER,
			() => [...this.buildCommands(buildPath), invocation()],
			{ configures: !this.isConfigured, save: true }
		);
	}

	runBuildTransferInstall() {
		return this.runBuildAndTransfer(true);
	}

	// ------------------------------------------------------------- password

	async setPassword() {
		const value = await vscode.window.showInputBox({
			title: 'Remote Password',
			prompt: 'Overrides the built-in default password for sshpass and remote sudo. Stored in VS Code SecretStorage.',
			password: true,
		});
		if (value === undefined || value === '') { return; }
		try {
			await this.secrets.store(PASSWORD_SECRET_KEY, value);
		} catch (error) {
			vscode.window.showErrorMessage(`Could not store the password: ${errorMessage(error)}. ${KEYRING_HINT}`);
			return;
		}
		this.password = value;
		this.changeEmitter.fire();
	}

	async clearPassword() {
		await this.secrets.delete(PASSWORD_SECRET_KEY);
		this.password = undefined;
		this.changeEmitter.fire();
	}

	/** True when a custom password is stored; otherwise the built-in default is used. */
	get hasPassword(): boolean {
		return this.password !== undefined;
	}
}

// ---------------------------------------------------------------- UI: tree

type TreeNode = SectionNode | ItemNode;

class SectionNode extends vscode.TreeItem {
	constructor(public readonly sectionId: SectionId, label: string, icon: string) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.id = `section-${sectionId}`;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = 'section';
	}
}

class ItemNode extends vscode.TreeItem {
	constructor(options: {
		label: string;
		icon: string;
		command: string;
		description?: string;
		tooltip?: string | vscode.MarkdownString;
		contextValue: string;
		iconColor?: string;
	}) {
		super(options.label, vscode.TreeItemCollapsibleState.None);
		this.id = options.command;
		this.description = options.description;
		this.tooltip = options.tooltip;
		this.contextValue = options.contextValue;
		this.iconPath = new vscode.ThemeIcon(
			options.icon,
			options.iconColor ? new vscode.ThemeColor(options.iconColor) : undefined
		);
		this.command = { command: options.command, title: options.label };
	}
}

class SidebarProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly controller: CustomCMakeController) {
		this.subscription = controller.onDidChange(() => this.changeEmitter.fire(undefined));
	}

	dispose() {
		this.subscription.dispose();
		this.changeEmitter.dispose();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeNode): TreeNode[] {
		if (!this.controller.workspacePath) { return []; }
		if (!element) {
			return [
				new SectionNode('build', 'Build', 'tools'),
				new SectionNode('transfer', 'Transfer', 'cloud-upload'),
				new SectionNode('actions', 'Actions', 'play'),
			];
		}
		if (element instanceof SectionNode) {
			switch (element.sectionId) {
				case 'build': return this.buildItems();
				case 'transfer': return this.transferItems();
				case 'actions': return this.actionItems();
			}
		}
		return [];
	}

	private setting(label: string, icon: string, command: string, value: string, tooltip: string): ItemNode {
		const isEmpty = value.length === 0;
		return new ItemNode({
			label,
			icon,
			command,
			description: isEmpty ? 'not set' : value,
			tooltip: `${tooltip}\n\nClick to change.`,
			contextValue: 'setting',
			iconColor: isEmpty ? 'list.warningForeground' : undefined,
		});
	}

	private buildItems(): ItemNode[] {
		const settings = this.controller.settings;
		return [
			this.setting('Architecture', 'chip', 'CustomCMake.selectSystem', settings.system, 'Target system / architecture'),
			this.setting('Build Type', 'symbol-enum', 'CustomCMake.selectConfigure', settings.configure, 'CMAKE_BUILD_TYPE used when configuring'),
			this.setting('Target', 'target', 'CustomCMake.selectBuild', settings.build, 'CMake target to build'),
			this.setting('Threads', 'pulse', 'CustomCMake.selectJobs',
				settings.jobs > 0 ? String(settings.jobs) : `auto (${this.controller.jobCount})`,
				'Parallel build jobs (like make -j). 0 = one per CPU core'),
		];
	}

	private transferItems(): ItemNode[] {
		const settings = this.controller.settings;
		const host = this.controller.remoteHost;
		return [
			this.setting('Username', 'account', 'CustomCMake.selectUsername', settings.username, 'Remote user for scp'),
			this.setting('Hostname', 'server', 'CustomCMake.selectHostname', host, 'Host used for 5-digit port targets'),
			this.setting('Targets', 'plug', 'CustomCMake.transferValue', settings.transfer.join(', '),
				'Port (15206), number (154 -> <prefix>154), alias (bsnl154) or user@host'),
			new ItemNode({
				label: 'Password',
				icon: 'key',
				command: this.controller.hasPassword ? 'CustomCMake.clearPassword' : 'CustomCMake.setPassword',
				description: this.controller.hasPassword ? 'custom (click to reset)' : 'default',
				tooltip: 'Password for sshpass and remote sudo. Uses the built-in default unless you set your own (kept in VS Code SecretStorage).',
				contextValue: 'setting',
			}),
		];
	}

	private action(label: string, icon: string, command: string, tooltip: string, extra: Partial<ConstructorParameters<typeof ItemNode>[0]> = {}): ItemNode {
		const isRunning = this.controller.runningName === label;
		return new ItemNode({
			label,
			icon: isRunning ? 'sync~spin' : icon,
			command,
			tooltip,
			contextValue: 'action',
			...extra,
			...(isRunning ? { description: 'running…', iconColor: undefined } : {}),
		});
	}

	private actionItems(): ItemNode[] {
		const configured = this.controller.isConfigured;
		return [
			...(this.controller.runningName
				? [new ItemNode({
					label: 'Stop',
					icon: 'debug-stop',
					command: 'CustomCMake.cancel',
					description: this.controller.runningName,
					tooltip: 'Stop the running task',
					contextValue: 'action',
					iconColor: 'errorForeground',
				})]
				: []),
			this.action('Configure', 'gear', 'CustomCMake.configureBuild', 'Run the CMake configure command',
				configured ? {} : { description: 'needed', iconColor: 'list.warningForeground' }),
			this.action('Build', 'tools', 'CustomCMake.build', 'Build (configures first if needed)'),
			this.action('Transfer', 'cloud-upload', 'CustomCMake.transfer', 'Upload the newest artifact to each selected target'),
			this.action(ACTION_BUILD_TRANSFER, 'rocket', 'CustomCMake.runAction', 'Build, then upload the artifact (no install)'),
			...(this.controller.isPackageTarget
				? [this.action(ACTION_TRANSFER_INSTALL, 'desktop-download', 'CustomCMake.transferInstall',
					'Upload the newest .ipk (no build) and opkg install it on each target'),
				this.action(ACTION_BUILD_TRANSFER_INSTALL, 'package', 'CustomCMake.runInstallAction',
					'Build the package, upload the newest .ipk, then opkg install it on each target')]
				: []),
			this.action('Clean', 'trash', 'CustomCMake.clean', 'Run the clean target'),
		];
	}
}

// ------------------------------------------------------------ UI: status bar

class StatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	private readonly subscription: vscode.Disposable;

	constructor(private readonly controller: CustomCMakeController) {
		this.item.command = 'CustomCMake.build';
		this.subscription = controller.onDidChange(() => this.render());
		this.render();
	}

	private render() {
		if (!this.controller.workspacePath) {
			this.item.hide();
			return;
		}
		const running = this.controller.runningName;
		if (running) {
			this.item.text = `$(sync~spin) ${running}…`;
			this.item.tooltip = 'Custom CMake: click to stop';
			this.item.command = 'CustomCMake.cancel';
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else {
			const { build, configure } = this.controller.settings;
			this.item.text = `$(tools) ${build} [${configure}]`;
			this.item.tooltip = 'Custom CMake: click to build';
			this.item.command = 'CustomCMake.build';
			this.item.backgroundColor = undefined;
		}
		this.item.show();
	}

	dispose() {
		this.subscription.dispose();
		this.item.dispose();
	}
}

// ------------------------------------------------------- UI: stop button view

/** A slim webview at the bottom of the sidebar with a red rounded Stop button, shown only while running. */
class StopViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'CustomCMakeStop';
	private view: vscode.WebviewView | undefined;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly controller: CustomCMakeController) {
		this.subscription = controller.onDidChange(() => this.render());
	}

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.onDidReceiveMessage(message => {
			if (message === 'stop') { void vscode.commands.executeCommand('CustomCMake.cancel'); }
		});
		view.onDidDispose(() => { this.view = undefined; });
		this.render();
	}

	private render() {
		if (!this.view) { return; }
		const nonce = crypto.randomBytes(16).toString('hex');
		const label = escapeHtml(this.controller.runningName ?? 'Task');
		this.view.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	body { padding: 8px 12px; display: flex; align-items: center; }
	button {
		background: var(--vscode-statusBarItem-errorBackground, #c72e0f);
		color: var(--vscode-statusBarItem-errorForeground, #fff);
		border: none; border-radius: 14px; padding: 6px 16px;
		font: inherit; font-size: 12px; cursor: pointer;
	}
	button:hover { filter: brightness(1.15); }
	button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style></head>
<body><button id="stop" title="Stop the running task">&#9632; Stop ${label}</button>
<script nonce="${nonce}">
	const vscodeApi = acquireVsCodeApi();
	document.getElementById('stop').addEventListener('click', () => vscodeApi.postMessage('stop'));
</script></body></html>`;
	}

	dispose() {
		this.subscription.dispose();
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}
