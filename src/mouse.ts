// SGR mouse reports in, click events out. Pure, and its own module for the
// reason dock.ts is: the pane entrypoint runs a poll loop on import, so logic
// that lives there is logic no test can reach.
//
// Only the SGR encoding (`1006`) is parsed. The legacy X10 encoding caps
// coordinates at column 223, and this pane can sit in a tab wider than that.

/** One button transition. Coordinates are 1-based, as the wire reports them. */
export interface MouseEvent {
  /** 0 left, 1 middle, 2 right. Wheel and motion are dropped before this. */
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  press: boolean;
  col: number;
  row: number;
}

// ESC [ < b ; x ; y (M press | m release)
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** The longest prefix that could still become a report. Anything shorter than a
 * complete report is held over rather than parsed, because a click can arrive
 * split across two reads. */
const PARTIAL = /\x1b(\[<?[0-9;]*)?$/;

/**
 * Decode every complete report in `buf`, and hand back whatever trailing bytes
 * might still be the start of one.
 *
 * Motion (bit 5) and wheel (bit 6) reports are dropped here rather than by the
 * caller: they are the high-frequency ones, and a widget has nothing to do with
 * either.
 */
export function parseMouse(buf: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  let end = 0;
  REPORT.lastIndex = 0;
  for (let m = REPORT.exec(buf); m; m = REPORT.exec(buf)) {
    end = m.index + m[0].length;
    const b = Number(m[1]);
    // Bit 5 is motion, bit 6 is the wheel; neither is a click.
    if ((b & 32) !== 0 || (b & 64) !== 0) continue;
    events.push({
      button: b & 3,
      shift: (b & 4) !== 0,
      alt: (b & 8) !== 0,
      ctrl: (b & 16) !== 0,
      press: m[4] === "M",
      col: Number(m[2]),
      row: Number(m[3]),
    });
  }
  const tail = buf.slice(end);
  // Keep only a plausible partial report. Anything else is input the widget has
  // no use for, and holding it would grow the buffer without bound.
  return { events, rest: PARTIAL.exec(tail)?.[0] ?? "" };
}
