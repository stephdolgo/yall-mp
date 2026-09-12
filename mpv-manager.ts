import {EventEmitter} from 'events';
import {app, screen, type BrowserWindow} from 'electron';
import Mpv, {StatusObject} from 'node-mpv';
import type {SubtitleSelection} from './src/app/model/project.types';
import path from 'path';
import {MediaTrack} from './shared/types/media.type';
import {execSync} from 'child_process';
import * as fs from 'fs';

const TIME_UPDATE_FPS = 10;

export class MpvManager extends EventEmitter {
  public mediaPath: string = '';
  public customMpvPath?: string;
  private mpv: Mpv | null = null;

  // macOS: mpv runs in its own window behind the app's transparent window.
  // applyGeometry() centres and sizes it over the video area.
  private geometryPoll: NodeJS.Timeout | null = null;
  private lastGeometry = '';
  private applyingGeometry = false;

  constructor(private win: BrowserWindow) {
    super();
  }

  public async start(
    mediaPath: string,
    audioTrackIndex: number | null,
    subtitleSelection: SubtitleSelection,
    allSubtitleTracks: MediaTrack[],
    useMpvSubtitles: boolean,
    subtitlesVisible: boolean,
    hardwareAcceleration: boolean,
    volume: number,
    isMuted: boolean
  ): Promise<void> {
    this.mediaPath = mediaPath;

    const options = {
      binary: this.getMpvExecutablePath(),
      time_update: (1 / TIME_UPDATE_FPS),
      // verbose: true
    };

    const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const scriptPath = path.join(basePath, 'mpv', 'yall_auto_pause.lua');

    const isMac = process.platform === 'darwin';

    const args = [
      `--script=${scriptPath}`,
      '--no-config',
      '--vo=gpu,xv,x11',
      `--hwdec=${hardwareAcceleration ? 'auto' : 'no'}`,
      '--no-osc',
      '--no-osd-bar',
      '--no-border',
      '--input-default-bindings=no',
      '--keep-open=always',
      '--idle=yes',
      '--pause',
      '--sub-visibility=no',
      '--hr-seek=default',
      '--hr-seek-framedrop=yes',
      '--cache=no',
      '--ontop=no',
      '--force-window=yes',
      '--vd-lavc-threads=0',          // Use all available CPU cores for decoding
      '--demuxer-max-bytes=150MiB',   // Increase demuxer cache
      '--demuxer-readahead-secs=20',  // Prefetch more data
      '--framedrop=vo',               // Drop frames visually if rendering is too slow to maintain sync
      '--vd-lavc-fast',               // Allow optimizations that might slightly violate spec but improve speed
      '--sws-allow-zimg=no',          // Disable zimg (can be slow/buggy on old systems), fallback to swscale
      `--volume=${volume}`,
      `--mute=${isMuted ? 'yes' : 'no'}`,
    ];

    if (isMac) {
      // macOS: gives us the window size we ask for, not the video's aspect ratio.
      // Also stops mpv resizing itself to the video's native resolution on load.
      args.push('--keepaspect-window=no');
      args.push('--auto-window-resize=no');
    } else {
      args.unshift(`--wid=${this.win.getNativeWindowHandle().readInt32LE(0)}`);
    }

    if (audioTrackIndex !== null) {
      args.push(`--aid=${audioTrackIndex}`);
    }

    let mpvRelativeSubtitleIndex: number | undefined = undefined;
    if (subtitleSelection.type === 'embedded') {
      // Find the 0-based position of the selected track within the list of ONLY subtitle tracks:
      const relativeIndex = allSubtitleTracks.findIndex(track => track.index === subtitleSelection.trackIndex);
      if (relativeIndex !== -1) {
        // MPV's relative track IDs are 1-based:
        mpvRelativeSubtitleIndex = (relativeIndex + 1);
        args.push(`--sid=${mpvRelativeSubtitleIndex}`);
        console.log(`[MpvManager] Mapped ffprobe absolute index ${subtitleSelection.trackIndex} to mpv relative index ${mpvRelativeSubtitleIndex}`);
      } else {
        console.warn(`[MpvManager] Could not find selected subtitle track index ${subtitleSelection.trackIndex} in the provided list.`);
      }
    }

    this.mpv = new Mpv(options, args);
    this.setupEventListeners();

    try {
      await this.mpv.start();
      console.log('[MpvManager] MPV process started successfully.');

      // Shared properties from custom Lua script:
      this.mpv.observeProperty('user-data/auto-pause-fired');

      // Observe EOF state to handle end of file cleanly
      this.mpv.observeProperty('eof-reached');

      await this.mpv.load(mediaPath, 'replace');
      console.log(`[MpvManager] Loaded media: ${mediaPath}`);

      if (subtitleSelection.type === 'external') {
        await this.mpv.addSubtitles(subtitleSelection.filePath, 'select');
        console.log(`[MpvManager] Added external subtitles: ${subtitleSelection.filePath}`);
      } else if (subtitleSelection.type === 'embedded' && mpvRelativeSubtitleIndex != null) {
        await this.mpv.selectSubtitles(mpvRelativeSubtitleIndex);
        console.log(`[MpvManager] Selected embedded subtitle track: ${mpvRelativeSubtitleIndex}`);
      }

      if (useMpvSubtitles) {
        if (subtitlesVisible) {
          await this.showSubtitles();
        } else {
          await this.hideSubtitles();
        }
      } else {
        await this.hideSubtitles();
      }

      if (isMac) {
        // macOS: polled, as Electron does not reliably emit move or resize
        // for programmatic setBounds() calls.
        this.applyGeometry(true);
        this.geometryPoll = setInterval(() => this.applyGeometry(), 200);
      }

      this.emit('ready');
    } catch (error) {
      console.error('[MpvManager] Failed to start MPV or load file:', error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    if (!this.mpv) {
      return;
    }

    this.mpv.on('status', (status: StatusObject) => {
      const prop = status.property as any;
      if (prop === 'user-data/auto-pause-fired') {
        this.emit('status', {event: 'auto-pause-fired', data: status.value});
      } else {
        this.emit('status', {
          event: 'property-change',
          name: status.property,
          data: status.value,
        });
      }
    });

    this.mpv.on('timeposition', (time: number) => {
      this.emit('status', {
        event: 'property-change',
        name: 'time-pos',
        data: time,
      });
    });

    this.mpv.on('paused', () => {
      this.emit('status', {
        event: 'property-change',
        name: 'pause',
        data: true,
      });
    });

    this.mpv.on('resumed', () => {
      this.emit('status', {
        event: 'property-change',
        name: 'pause',
        data: false,
      });
    });

    this.mpv.on('seek', () => {
      this.emit('status', {event: 'seek'});
    });

    this.mpv.on('started', () => {
      this.emit('status', {event: 'playback-restart'});
    });

    this.mpv.on('stopped', () => {
      this.emit('status', {event: 'end-file'});
    });

    this.mpv.on('crashed', () => {
      const err = new Error('MPV process has crashed.');
      console.error(`[MpvManager] MPV process crashed.`);
      this.emit('error', err);
    });
  }

  public sendCommand(command: any[]): Promise<any> {
    if (!this.mpv) {
      return Promise.reject(new Error('MPV is not running.'));
    }

    const [commandName, ...args] = command;
    const stringArgs = args.map(arg => String(arg));
    return this.mpv.command(commandName, stringArgs);
  }

  public async setProperty(property: string, value: any): Promise<void> {
    if (!this.mpv) {
      throw new Error('MPV is not running.');
    }
    await this.mpv.setProperty(property, value);
  }

  public getProperty(property: string): Promise<any> {
    if (!this.mpv) {
      return Promise.reject(new Error('MPV is not running.'));
    }
    return this.mpv.getProperty(property);
  }

  public observeProperty(property: string): void {
    if (!this.mpv) {
      console.error('Cannot observe property: MPV is not running.');
      return;
    }
    this.mpv.observeProperty(property);
  }

  private currentGeometry(): string | null {
    // Position and size as one string, so a change can be spotted in one comparison.
    if (!this.win || this.win.isDestroyed()) {
      return null;
    }
    const b = this.win.getBounds();
    return `${Math.round(b.width)}x${Math.round(b.height)}+${Math.round(b.x)}+${Math.round(b.y)}`;
  }

  private applyGeometry(force = false): void {
    // macOS: sizes and centres mpv's window over the app's video area.
    // window-scale does the sizing, as geometry only moves a window at runtime.
    if (process.platform !== 'darwin' || !this.mpv || this.applyingGeometry) {
      return;
    }
    if (!this.win || this.win.isDestroyed()) {
      return;
    }

    const windowKey = this.currentGeometry();
    if (!windowKey) {
      return;
    }

    const bounds = this.win.getBounds();
    this.applyingGeometry = true;

    void (async () => {
      try {
        const videoWidth = Number(await this.mpv?.getProperty('dwidth'));
        const videoHeight = Number(await this.mpv?.getProperty('dheight'));

        if (!videoWidth || !videoHeight) {
          // Nothing loaded yet. Clearing the marker makes the next poll retry.
          this.lastGeometry = '';
          return;
        }

        const key = `${windowKey}@${videoWidth}x${videoHeight}`;
        if (!force && key === this.lastGeometry) {
          return;
        }

        // mpv needs pixels, Electron gives points.
        const display = screen.getDisplayMatching(bounds);
        const dpr = display.scaleFactor || 1;

        // Electron measures y from the display top, mpv from the work area.
        // The work area starts below the menu bar.
        const originX = display.workArea.x - display.bounds.x;
        const originY = display.workArea.y - display.bounds.y;

        const fitScale = Math.min(bounds.width / videoWidth, bounds.height / videoHeight);
        if (!isFinite(fitScale) || fitScale <= 0) {
          this.lastGeometry = '';
          return;
        }

        const scale = fitScale * dpr;
        await this.mpv?.setProperty('window-scale', scale);

        // size of window in points
        const scaledWidth = Math.round(videoWidth * fitScale);
        const scaledHeight = Math.round(videoHeight * fitScale);
        const xPoints = bounds.x + (bounds.width - scaledWidth) / 2;
        const yPoints = bounds.y + (bounds.height - scaledHeight) / 2;

        // size of window in pixels
        const x = Math.round((xPoints - originX) * dpr);
        const y = Math.round((yPoints - originY) * dpr);

        await this.mpv?.setProperty('geometry', `+${x}+${y}`);

        // Where mpv actually landed, for the backdrop to reveal.
        this.emit('video-rect', {
          x: x / dpr + originX,
          y: y / dpr + originY,
          width: scaledWidth,
          height: scaledHeight,
        });

        this.lastGeometry = key;
      } catch (err) {
        // Left in: if the video ever stops following the window, this says why.
        console.warn('[mpv geometry] failed:', err);
        this.lastGeometry = '';
      } finally {
        this.applyingGeometry = false;
      }
    })();
  }

  public stop(): void {
    if (this.geometryPoll) {
      clearInterval(this.geometryPoll);
      this.geometryPoll = null;
    }
    this.lastGeometry = '';

    this.emit('video-rect', null);  // No video window: the backdrop becomes solid.

    if (this.mpv) {
      this.mpv.quit();
      this.mpv = null;
    }
  }

  public showSubtitles(): Promise<void> {
    if (!this.mpv) {
      return Promise.reject(new Error('MPV is not running.'));
    }
    return this.mpv.showSubtitles();
  }

  public hideSubtitles(): Promise<void> {
    if (!this.mpv) {
      return Promise.reject(new Error('MPV is not running.'));
    }
    return this.mpv.hideSubtitles();
  }

  public setLuaAutoPause(endTime: number, token: string): void {
    this.mpv?.command('script-message', ['set-auto-pause', endTime.toString(), token]);
  }

  private getMpvExecutablePath(): string {
    if (this.customMpvPath && fs.existsSync(this.customMpvPath)) {
      return this.customMpvPath;
    } else if (this.customMpvPath) {
      console.warn(`[MpvManager] Custom MPV path invalid: ${this.customMpvPath}. Falling back to default.`);
    }

    const platform = process.platform;

    // On Windows, use the downloaded binary
    if (platform === 'win32') {
      const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath();
      return path.join(basePath, 'electron-resources', 'windows', 'mpv.exe');
    }

    // On macOS/Linux, resolve absolute system path
    try {
      // Try the 'which' command first (works for most Linux terminal starts)
      const resolvedPath = execSync('which mpv').toString().trim();
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        return resolvedPath;
      }
    } catch (e) {
      // 'which' failed (common in macOS GUI apps or restrictive Linux envs)
    }

    // Fallback: Check common install locations manually
    const commonPaths = [
      '/usr/bin/mpv',           // Standard Linux
      '/usr/local/bin/mpv',     // Intel Mac / Linux user
      '/opt/homebrew/bin/mpv',  // Apple Silicon Mac
      '/sw/bin/mpv'             // Fink/MacPorts
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Last resort - the global PATH
    return 'mpv';
  }
}
