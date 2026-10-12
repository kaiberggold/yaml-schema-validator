export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

/** Converts between offsets and zero based line / character positions. */
export class LineIndex {
    private readonly starts: number[] = [0];

    constructor(readonly text: string) {
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10) {
                this.starts.push(i + 1);
            }
        }
    }

    get lineCount(): number {
        return this.starts.length;
    }

    positionAt(offset: number): Position {
        offset = Math.max(0, Math.min(offset, this.text.length));
        let lo = 0;
        let hi = this.starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.starts[mid] <= offset) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return { line: lo, character: offset - this.starts[lo] };
    }

    offsetAt(pos: Position): number {
        if (pos.line >= this.starts.length) {
            return this.text.length;
        }
        const start = this.starts[Math.max(0, pos.line)];
        return Math.min(start + pos.character, this.lineEnd(pos.line));
    }

    lineEnd(line: number): number {
        const next = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
        return next > 0 && this.text[next - 1] === '\r' ? next - 1 : next;
    }

    range(start: number, end: number): Range {
        return { start: this.positionAt(start), end: this.positionAt(end) };
    }
}
