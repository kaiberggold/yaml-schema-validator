import { Range } from './lineIndex';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

/** A location in some file, used for related information and links. */
export interface Location {
    file: string;
    range: Range;
}

export interface RelatedInfo {
    location: Location;
    message: string;
}

/**
 * Problem kinds. Apart from the first three they are named after the JSON
 * Schema keyword that failed, so `errorMessage` / `x-severity` maps can use
 * keyword names (`additionalProperties` = unknown key, `false` = a `false` schema).
 */
export type ProblemKind =
    | 'syntax'
    | 'include'
    | 'schema'
    | 'type'
    | 'required'
    | 'additionalProperties'
    | 'additionalItems'
    | 'enum'
    | 'const'
    | 'pattern'
    | 'format'
    | 'minimum'
    | 'maximum'
    | 'exclusiveMinimum'
    | 'exclusiveMaximum'
    | 'multipleOf'
    | 'minLength'
    | 'maxLength'
    | 'minItems'
    | 'maxItems'
    | 'uniqueItems'
    | 'contains'
    | 'maxContains'
    | 'unevaluatedProperties'
    | 'unevaluatedItems'
    | 'minProperties'
    | 'maxProperties'
    | 'propertyNames'
    | 'dependentRequired'
    | 'anyOf'
    | 'oneOf'
    | 'not'
    | 'false'
    | 'deprecated'
    | 'anchor';

export interface Problem {
    file: string;
    range: Range;
    severity: Severity;
    message: string;
    kind: ProblemKind;
    /** Location of the scheme rule that produced the problem (used as clickable diagnostic code). */
    rule?: Location;
    related: RelatedInfo[];
    deprecated?: boolean;
    /** Summary of the problems inside an included file (shown on the include line). */
    summary?: boolean;
}

/** Abstraction over the file system so that open (unsaved) editors take precedence. */
export interface FileHost {
    /** Returns the file content or undefined if it does not exist. */
    read(file: string): string | undefined;
    exists(file: string): boolean;
}

export function severityRank(s: Severity): number {
    return s === 'error' ? 0 : s === 'warning' ? 1 : s === 'info' ? 2 : 3;
}

export function problemKey(p: Problem): string {
    const r = p.range;
    return `${p.file}|${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}|${p.severity}|${p.message}`;
}
