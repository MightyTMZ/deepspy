import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface PolicyViolation {
  action: string;
  target: string;
  rule: string;
}

interface Blocklist {
  blockedClickLabels: string[];
  blockedInputFields: string[];
  blockedInputFieldSelectors: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLOCKLIST_PATH = resolve(
  __dirname,
  "..",
  "fixtures",
  "blocklist.json",
);

export class Policy {
  private blocklist: Blocklist;

  constructor(blocklistPath?: string) {
    const raw = readFileSync(blocklistPath ?? DEFAULT_BLOCKLIST_PATH, "utf-8");
    this.blocklist = JSON.parse(raw);
  }

  /**
   * Check if an action is allowed. Returns null if OK, violation if blocked.
   */
  check(action: {
    method: string;
    description: string;
    selector: string;
    arguments?: string[];
  }): PolicyViolation | null {
    const desc = action.description.toLowerCase();
    const selector = action.selector.toLowerCase();

    // Check click-type actions against blocked labels
    if (action.method === "click" || action.method === "act") {
      for (const label of this.blocklist.blockedClickLabels) {
        if (desc.includes(label.toLowerCase())) {
          return {
            action: action.method,
            target: action.description,
            rule: `Blocked click label: "${label}"`,
          };
        }
      }
    }

    // Check type/fill actions against blocked field patterns
    if (
      action.method === "type" ||
      action.method === "fill" ||
      action.method === "act"
    ) {
      for (const field of this.blocklist.blockedInputFields) {
        if (desc.includes(field.toLowerCase()) || selector.includes(field.toLowerCase())) {
          return {
            action: action.method,
            target: action.description,
            rule: `Blocked input field: "${field}"`,
          };
        }
      }
      for (const sel of this.blocklist.blockedInputFieldSelectors) {
        if (selector.includes(sel.toLowerCase())) {
          return {
            action: action.method,
            target: action.description,
            rule: `Blocked input selector: "${sel}"`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Check a text input action against blocked field labels.
   */
  checkInput(fieldLabel: string, _value: string): PolicyViolation | null {
    const label = fieldLabel.toLowerCase();
    for (const field of this.blocklist.blockedInputFields) {
      if (label.includes(field.toLowerCase())) {
        return {
          action: "input",
          target: fieldLabel,
          rule: `Blocked input field: "${field}"`,
        };
      }
    }
    return null;
  }
}
