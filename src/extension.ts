"use strict";

import * as path from "path"
import * as net from "net";
import * as vscode from "vscode";
import * as semver from "semver";
import * as cp from "child_process";
import { PythonExtension } from "@vscode/python-extension";
import { LanguageClient, LanguageClientOptions, ServerOptions, State } from "vscode-languageclient/node";

const MIN_PYTHON = semver.parse("3.10.0")

let client: LanguageClient
let python: PythonExtension
let logger: vscode.LogOutputChannel

const execShell = (command: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
        cp.exec(`${command} ${args.join(" ")}`, (err, out) => {
            if (err) {
                return reject(err);
            }
            return resolve(out);
        });
    });

/**
 * This is the main entry point.
 * Called when vscode first activates the extension
 */
export async function activate(context: vscode.ExtensionContext) {
    logger = vscode.window.createOutputChannel('pydjinni', { log: true })
    logger.info("Extension activated.")

    try {
        python = await PythonExtension.api();
    } catch (err) {
        logger.error(`Unable to load python extension: ${err}`)
    }

    // Restart language server command
    context.subscriptions.push(
        vscode.commands.registerCommand("pydjinni.server.restart", async () => {
            logger.info('restarting server...')
            await startLangServer()
        })
    )

    // Restart the language server if the user switches Python envs...
    context.subscriptions.push(
        python.environments.onDidChangeActiveEnvironmentPath(async () => {
            logger.info('python env modified, restarting server...')
            await startLangServer()
        })
    )

    // ... or if they change a relevant config option
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration("pydjinni.server") || event.affectsConfiguration("pydjinni.client")) {
                logger.info('config modified, restarting server...')
                await startLangServer()
            }
        })
    )

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (event) => {
            vscode.Uri.file
            if(event.document.uri == vscode.workspace.getConfiguration('pydjinni.client').get<vscode.Uri>('cwd')) {
                logger.info('PyDjinni configuration has changed, restarting server')
                await startLangServer()
            }
        })
    )

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider("pydjinni", new class implements vscode.TextDocumentContentProvider {

            // emitter and its event
            onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
            onDidChange = this.onDidChangeEmitter.event;
    
            async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
                if(uri.path == "/configuration.schema.json") {
                    return execShell(
                        getCommand("pydjinni-language-server"), ["config-schema"]
                    )
                } else {
                    return Promise.reject(new Error(`Document not found: ${uri.toString()}`));
                }
                
            }
        })
    )

    await startLangServer()
}

export function deactivate(): Thenable<void> {
    return stopLangServer()
}


async function startLangServer() {
    const serverOptions: ServerOptions = {
        command: getCommand("pydjinni-language-server"),
        args: ["start", "--connection", "STDIO"]
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'pydjinni' }],
        outputChannel: logger,
        connectionOptions: {
            maxRestartCount: 3 // don't restart on server failure.
        },
    };

    client = new LanguageClient('pydjinni-language-server', serverOptions, clientOptions);
    await client.start()
}

async function stopLangServer(): Promise<void> {
    if (!client) {
        return
    }

    if (client.state === State.Running) {
        await client.stop()
    }

    client.dispose()
    client = undefined
}

function getCommand(command: string): string {
    const activeEnvPath = python.environments.getActiveEnvironmentPath()
    return path.join(path.dirname(activeEnvPath.path), command)
}