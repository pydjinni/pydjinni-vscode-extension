// Copyright 2024 - 2025 jothepro
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

import * as vscode from 'vscode'
import * as cp from 'child_process'
import { PythonExtension } from '@vscode/python-extension'
import { LanguageClient, LanguageClientOptions, ServerOptions, State } from 'vscode-languageclient/node'

let client: LanguageClient
let python: PythonExtension
let logger: vscode.LogOutputChannel
const language_server = 'pydjinni_language_server'

/**
 * Extension entrypoint.
 * Called when vscode first activates the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
    logger = vscode.window.createOutputChannel('PyDjinni', { log: true })
    logger.info('PyDjinni extension activated.')

    python = await PythonExtension.api()

    // registering JSON schema for pydjinni.yaml
    const yaml = vscode.extensions.getExtension('redhat.vscode-yaml')
    if (yaml) {
        yaml.exports.registerContributor(
            'pydjinni',
            () => undefined,
            async (rawUri: string) => {
                const uri = vscode.Uri.parse(rawUri)
                if (uri.path == '/configuration.schema.json') {
                    return execPython(language_server, ['config-schema'])
                } else {
                    return Promise.reject(new Error(`Document not found: ${uri.toString()}`))
                }
            }
        )
    }

    // registering JSON schema for pydjinni.json
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            'pydjinni',
            new (class implements vscode.TextDocumentContentProvider {
                // emitter and its event
                onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>()
                onDidChange = this.onDidChangeEmitter.event

                async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
                    if (uri.path == '/configuration.schema.json') {
                        return execPython(language_server, ['config-schema'])
                    } else {
                        return Promise.reject(new Error(`Document not found: ${uri.toString()}`))
                    }
                }
            })()
        )
    )

    // Restart language server command
    context.subscriptions.push(
        vscode.commands.registerCommand('pydjinni.server.restart', async () => {
            logger.info('restarting server...')
            await client.restart()
        })
    )

    // Restart the language server if the user switches Python envs...
    context.subscriptions.push(
        python.environments.onDidChangeActiveEnvironmentPath(async () => {
            logger.info('python env modified, restarting server...')
            await client.restart()
        })
    )

    // ... or if they change a relevant config option
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (event.affectsConfiguration('pydjinni.debugLogs')) {
                logger.info('config `pydjinni.debugLogs` modified, restarting server...')
                await client.restart()
            }
        })
    )

    await startLangServer()
}

export async function deactivate(): Promise<void> {
    await client.stop()
    await client.dispose()
}

async function startLangServer() {
    await checkLanguageServerAvailability()
    const configuration = vscode.workspace.getConfiguration('pydjinni')
    const debugLogs = configuration.get<boolean>('debugLogs')

    let args = ['--connection', 'STDIO']
    if (debugLogs) {
        args = args.concat(['--log', 'pydjinni-language-server.log'])
    }
    const serverOptions: ServerOptions = {
        command: python.environments.getActiveEnvironmentPath().path,
        args: ['-m', language_server, 'start'].concat(args),
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'pydjinni' }],
        outputChannel: logger,
        connectionOptions: {
            maxRestartCount: 3, // don't restart on server failure.
        },
    }

    client = new LanguageClient('pydjinni-language-server', serverOptions, clientOptions)
    await client.start()
}

/**
 * Executes a Python module in the currently active Python environment
 * @param module name of the module
 * @param args list of arguments that should be passed to the module
 * @returns the output that was printed to stdout by the executed module
 */
const execPython = (module: string, args: string[] = []) =>
    new Promise<string>((resolve, reject) => {
        const activeEnvPath = python.environments.getActiveEnvironmentPath().path
        cp.exec(`${activeEnvPath} -m ${module} ${args.join(' ')}`, (err, out) => {
            if (err) {
                return reject(err)
            }
            return resolve(out)
        })
    })

/**
 * Checks if the `pydjinni_language_server` Python module is available in the active Python environment.
 * Shows an error message if the module cannot be found.
 * The user then has the choice to either install the latest version of PyDjinni in the current Python environment, or
 * to reload the workspace in order to try loading the extension again.
 */
async function checkLanguageServerAvailability() {
    try {
        await execPython(language_server, ['--version'])
    } catch (err) {
        logger.error(`Could not find ${language_server} module in the active Python environment!`, err)
        const action_install = 'Install PyDjinni'
        const action_reload = 'Reload'
        const selection = await vscode.window.showErrorMessage(
            `PyDjinni: Could not find Language Server!`,
            action_install,
            action_reload
        )
        switch (selection) {
            case action_install:
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Installing PyDjinni',
                        cancellable: true,
                    },
                    (progress, token) => {
                        return execPython('pip', ['install', 'pydjinni'])
                    }
                )
            case action_reload:
                await vscode.commands.executeCommand('workbench.action.restartExtensionHost')
        }
    }
}
