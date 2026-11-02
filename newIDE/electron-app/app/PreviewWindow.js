const {
  BrowserWindow, // Module to create native browser window.
  ipcMain,
  shell,
  screen,
} = require('electron');
const isDev = require('electron-is-dev');
const { load } = require('./Utils/UrlLoader');

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
// Map of preview windows with their parent window ID: { previewWindow, parentWindowId }
let previewWindows = [];

let openDevToolsByDefault = false;

/**
 * Open 1 or multiple windows running a preview of an exported game.
 */
const openPreviewWindow = ({
  parentWindow,
  previewBrowserWindowOptions,
  previewGameIndexHtmlPath,
  alwaysOnTop,
  hideMenuBar,
  numberOfWindows,
  captureOptions,
  openEvent,
}) => {
  // If opening multiple windows at once, place them across the screen.
  const screenSize = screen.getPrimaryDisplay().workAreaSize;
  const screenWidth = screenSize.width;
  const screenHeight = screenSize.height;
  const positions = {
    // top-left
    1: { x: 0, y: 0 },
    // top-right
    2: { x: screenWidth / 2, y: 0 },
    // bottom-left
    3: { x: 0, y: screenHeight / 2 },
    // bottom-right
    4: { x: screenWidth / 2, y: screenHeight / 2 },
  };
  const createdWindowIds = [];
  for (let i = 0; i < numberOfWindows; i++) {
    const browserWindowOptions = {
      ...previewBrowserWindowOptions,
      parent: alwaysOnTop ? parentWindow : null,
      x: numberOfWindows > 1 ? positions[i + 1].x : undefined,
      y: numberOfWindows > 1 ? positions[i + 1].y : undefined,
    };

    let previewWindow = new BrowserWindow(browserWindowOptions);
    // Read the id now: the window is destroyed when the "closed" event fires,
    // so the id must not be read from `previewWindow` in its handler.
    const windowId = previewWindow.id;

    previewWindow.setMenuBarVisibility(hideMenuBar);
    previewWindow.webContents.on('devtools-opened', () => {
      openDevToolsByDefault = true;
    });
    previewWindow.webContents.on('devtools-closed', () => {
      openDevToolsByDefault = false;
    });

    if (openDevToolsByDefault) previewWindow.openDevTools();

    // Enable `@electron/remote` module for renderer process
    require('@electron/remote/main').enable(previewWindow.webContents);

    // Open external link in the OS default browser
    previewWindow.webContents.setWindowOpenHandler(details => {
      shell.openExternal(details.url);
      return { action: 'deny' };
    });

    previewWindow.loadURL(previewGameIndexHtmlPath);

    // Track this preview window with its parent
    previewWindows.push({
      previewWindow: previewWindow,
      parentWindowId: parentWindow ? parentWindow.id : null,
    });
    createdWindowIds.push(windowId);

    previewWindow.on('closed', closeEvent => {
      previewWindows = previewWindows.filter(
        entry => entry.previewWindow !== previewWindow
      );
      // Only send message if the parent window still exists. The closed
      // window id is sent so that launchers can find the launch that owns
      // the window (and its capture options).
      if (openEvent.sender && !openEvent.sender.isDestroyed()) {
        openEvent.sender.send('preview-window-closed', windowId);
      }
      previewWindow = null;
    });
  }

  return createdWindowIds;
};

const closePreviewWindow = windowId => {
  // Same guards as the two functions below: the registry entry is only
  // removed when 'closed' fires, so in a close race (a crashed renderer, a
  // window closed by the user while the request is in flight) the entry can
  // still hold a destroyed window. Reading `.id` on it threw "Object has
  // been destroyed" out of the IPC handler and rejected the renderer's
  // ipcRenderer.invoke.
  try {
    const entry = previewWindows.find(entry =>
      entry.previewWindow && !entry.previewWindow.isDestroyed()
        ? entry.previewWindow.id === windowId
        : false
    );
    if (entry && entry.previewWindow && !entry.previewWindow.isDestroyed()) {
      entry.previewWindow.close();
    }
  } catch (error) {
    console.warn('Ignoring exception when closing preview window:', error);
  }
};

const closePreviewWindowsForParent = parentWindowId => {
  const entriesToClose = previewWindows.filter(
    entry => entry.parentWindowId === parentWindowId
  );
  entriesToClose.forEach(entry => {
    try {
      if (entry.previewWindow && !entry.previewWindow.isDestroyed()) {
        entry.previewWindow.close();
      }
    } catch (error) {
      console.warn('Ignoring exception when closing preview window:', error);
    }
  });
};

const closeAllPreviewWindows = () => {
  previewWindows.forEach(entry => {
    try {
      if (entry.previewWindow && !entry.previewWindow.isDestroyed()) {
        entry.previewWindow.close();
      }
    } catch (error) {
      console.warn('Ignoring exception when closing preview window:', error);
    }
  });
};

// The live registry of open preview windows, for the BYOK preview-capture
// IPC (read-only access: entries are managed by open/close above).
const getPreviewWindows = () => previewWindows;

module.exports = {
  openPreviewWindow,
  closePreviewWindow,
  closePreviewWindowsForParent,
  closeAllPreviewWindows,
  getPreviewWindows,
};
