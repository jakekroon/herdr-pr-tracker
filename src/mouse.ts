// SGR (`1006`) mouse reports in, click events out. The legacy encoding caps a
// coordinate at column 223, and the pane can sit in a wider tab.

/** One button transition. Coordinates are 1-based, as the wire reports them. */
export interface MouseEvent {
  /** 0 left, 1 middle, 2 right. */
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
/** A click can arrive split across two reads, so a partial report is held over. */
const PARTIAL = /\x1b(\[<?[0-9;]*)?$/;

/**
 * Decode every complete report in `buf`, and return the trailing bytes that
 * could still start one. Motion and wheel reports are dropped.
 */
export function parseMouse(buf: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  let end = 0;
  REPORT.lastIndex = 0;
  for (let m = REPORT.exec(buf); m; m = REPORT.exec(buf)) {
    end = m.index + m[0].length;
    const b = Number(m[1]);
    // Bit 5 is motion, bit 6 is the wheel.
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
  // Hold only a plausible partial report, or the buffer grows without bound.
  return { events, rest: PARTIAL.exec(tail)?.[0] ?? "" };
}
