import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';

const run = promisify(execFile);

/** Process ids of running desktop apps, so a helper can find the dialog of the right one. */
export const desktopPids = new WeakMap<Page, number>();

/**
 * Fills in and confirms a real Windows file dialog using window messages. It finds the
 * dialog by process id and sends no global keystrokes, so it works without focus and cannot
 * type into another window on the machine.
 *
 * It confirms only after reading the file name box back. If the box does not hold exactly
 * the requested path, it cancels, because confirming would save to the dialog's default
 * location, which is the user's own Documents folder.
 */
function dialogScript(pid: number, path: string | null): string {
  const source = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FileDialogDriver {
  delegate bool EnumProc(IntPtr handle, IntPtr state);
  [DllImport("user32")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
  [DllImport("user32")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr state);
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32")] static extern IntPtr GetParent(IntPtr handle);
  [DllImport("user32")] static extern int GetDlgCtrlID(IntPtr handle);
  [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int size);
  [DllImport("user32", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr SendText(IntPtr handle, uint message, IntPtr wParam, StringBuilder lParam);
  [DllImport("user32")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

  const uint WM_COMMAND = 0x0111, WM_GETTEXT = 0x000D, WM_CHAR = 0x0102, EM_SETSEL = 0x00B1, BM_CLICK = 0x00F5;

  static string ClassOf(IntPtr handle) {
    var name = new StringBuilder(256);
    GetClassName(handle, name, 256);
    return name.ToString();
  }

  static bool HasAncestor(IntPtr handle, string className) {
    for (var current = GetParent(handle); current != IntPtr.Zero; current = GetParent(current)) {
      if (ClassOf(current) == className) return true;
    }
    return false;
  }

  static IntPtr FindDialog(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, state) => {
      uint pid;
      GetWindowThreadProcessId(handle, out pid);
      if (pid == targetPid && IsWindowVisible(handle) && ClassOf(handle) == "#32770") { found = handle; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // The address bar holds a similar box, which is why its ancestors are excluded.
  static IntPtr FindFileNameBox(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, state) => {
      if (IsWindowVisible(handle) && ClassOf(handle) == "Edit" && ClassOf(GetParent(handle)) == "ComboBox" && !HasAncestor(handle, "Address Band Root")) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static IntPtr FindConfirmButton(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, state) => {
      if (ClassOf(handle) == "Button" && GetDlgCtrlID(handle) == 1 && IsWindowVisible(handle)) { found = handle; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static string TextOf(IntPtr box) {
    var text = new StringBuilder(1024);
    SendText(box, WM_GETTEXT, new IntPtr(text.Capacity), text);
    return text.ToString();
  }

  public static void Answer(uint pid, string path) {
    var deadline = DateTime.UtcNow.AddSeconds(30);
    IntPtr dialog = IntPtr.Zero, box = IntPtr.Zero, button = IntPtr.Zero;
    while (DateTime.UtcNow < deadline) {
      dialog = FindDialog(pid);
      if (dialog != IntPtr.Zero) {
        box = FindFileNameBox(dialog);
        button = FindConfirmButton(dialog);
      }
      if (box != IntPtr.Zero && button != IntPtr.Zero) break;
      System.Threading.Thread.Sleep(100);
    }
    if (box == IntPtr.Zero || button == IntPtr.Zero) throw new Exception("No file dialog with a file name box appeared");

    // Typed one character at a time, because a Save dialog ignores text that is only assigned.
    // A dialog can show its box slightly before it accepts input, so this tries a few times.
    var actual = "";
    for (var attempt = 0; attempt < 10; attempt += 1) {
      SendMessage(box, EM_SETSEL, IntPtr.Zero, new IntPtr(-1));
      foreach (var character in path) SendMessage(box, WM_CHAR, new IntPtr(character), IntPtr.Zero);
      System.Threading.Thread.Sleep(150);
      actual = TextOf(box);
      if (string.Equals(actual, path, StringComparison.OrdinalIgnoreCase)) break;
      System.Threading.Thread.Sleep(300);
    }
    if (!string.Equals(actual, path, StringComparison.OrdinalIgnoreCase)) {
      PostMessage(dialog, WM_COMMAND, new IntPtr(2), IntPtr.Zero);
      throw new Exception("The file name box held '" + actual + "' instead of the requested path, so the dialog was cancelled");
    }
    PostMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
  }

  public static void Cancel(uint pid) {
    var deadline = DateTime.UtcNow.AddSeconds(30);
    while (DateTime.UtcNow < deadline) {
      var dialog = FindDialog(pid);
      if (dialog != IntPtr.Zero) {
        PostMessage(dialog, WM_COMMAND, new IntPtr(2), IntPtr.Zero);
        return;
      }
      System.Threading.Thread.Sleep(100);
    }
    throw new Exception("No file dialog appeared");
  }
}`;
  const call = path === null ? `[FileDialogDriver]::Cancel(${pid})` : `[FileDialogDriver]::Answer(${pid}, '${path.replaceAll("'", "''")}')`;
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${source}
'@
${call}`;
}

/** Presses Cancel on a real dialog. Start it before the action that opens the dialog. */
export async function cancelNativeDialog(page: Page): Promise<void> {
  const pid = desktopPids.get(page);
  if (!pid) throw new Error('This page does not belong to a desktop app');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', dialogScript(pid, null)], { timeout: 60_000 });
}

/** Start this before the action that opens the dialog, and await it after. */
export async function answerNativeDialog(page: Page, path: string): Promise<void> {
  const pid = desktopPids.get(page);
  if (!pid) throw new Error('This page does not belong to a desktop app');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', dialogScript(pid, path)], { timeout: 60_000 });
}
