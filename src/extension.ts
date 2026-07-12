import * as vscode from 'vscode';
import { SearchViewProvider } from './searchViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SearchViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SearchViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('obsidianlikeSearch.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.obsidianlikeSearch');
      provider.focusInput();
    })
  );
}

export function deactivate(): void {}
