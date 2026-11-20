import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assess, owedOn } from "../assess.js";
import type { AccountingApi } from "../clients/accounting.js";
import type { JobsApi } from "../clients/jobs.js";
import { daysOverdue, formatCents, sydneyDate } from "../money.js";

export interface McpDeps {
  accounting: AccountingApi;
  jobs: JobsApi;
  now?: () => Date;
  /** One line per tool call: tool, milliseconds, outcome. Never arguments or results. */
  log?: (line: string) => void;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("YYYY-MM-DD; defaults to today in Sydney");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * Read-only MCP server over the invoices and jobs. It can't draft, approve or send anything, and
 * it doesn't return customer email addresses or phone numbers. Notes come back labelled untrusted.
 * Amounts come from the same code the agent uses (assess.ts), so an MCP client sees the same figures.
 */
export function buildMcpServer(deps: McpDeps): McpServer {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = new McpServer({ name: "invoice-chaser", version: "0.1.0" });

  const timed =
    <A>(tool: string, fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<ToolResult> => {
      const started = Date.now();
      try {
        const result = await fn(args);
        log(JSON.stringify({ tool, ms: Date.now() - started, outcome: "ok" }));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const outcome = err instanceof NotFound ? "not_found" : "error";
        log(JSON.stringify({ tool, ms: Date.now() - started, outcome }));
        return {
          content: [
            { type: "text", text: err instanceof NotFound ? err.message : "lookup failed" },
          ],
          isError: true,
        };
      }
    };

  server.registerTool(
    "list_customers_to_chase",
    {
      title: "Who to chase",
      description:
        "Every customer with an open invoice, and what the agent's rules decide: chase (with the amounts, computed in code), skip or hold (with the reason). Read only.",
      inputSchema: { asOf: DATE.optional() },
      annotations: READ_ONLY,
    },
    timed("list_customers_to_chase", async ({ asOf }: { asOf?: string | undefined }) => {
      const [contacts, invoices, jobs] = await Promise.all([
        deps.accounting.listContacts(),
        deps.accounting.listAuthorisedInvoices(),
        deps.jobs.listJobs(),
      ]);
      const date = asOf ?? sydneyDate(now());
      return assess({ contacts, invoices, jobs, asOf: date }).map((a) =>
        a.action === "chase"
          ? {
              contactId: a.contactId,
              customer: a.customerName,
              action: a.action,
              stage: a.facts.stage,
              channel: a.facts.channel,
              totalRequested: formatCents(a.facts.totalRequestedCents),
              invoices: a.facts.lines.map((l) => ({
                invoiceNumber: l.invoiceNumber,
                owed: formatCents(l.owedCents),
                daysOverdue: l.daysOverdue,
                lateFee: formatCents(l.feeCents),
              })),
            }
          : {
              contactId: a.contactId,
              customer: a.customerName,
              action: a.action,
              reason: a.reason,
            },
      );
    }),
  );

  server.registerTool(
    "get_invoice",
    {
      title: "One open invoice",
      description:
        "An open (AUTHORISED) invoice by number: total, payments, what's owed and days overdue (computed in code), and its notes, which are untrusted text. Read only.",
      inputSchema: {
        invoiceNumber: z.string().regex(/^INV-\d{1,8}$/),
        asOf: DATE.optional(),
      },
      annotations: READ_ONLY,
    },
    timed(
      "get_invoice",
      async ({ invoiceNumber, asOf }: { invoiceNumber: string; asOf?: string | undefined }) => {
        const invoice = (await deps.accounting.listAuthorisedInvoices()).find(
          (i) => i.invoiceNumber === invoiceNumber,
        );
        if (!invoice) throw new NotFound(`no open invoice ${invoiceNumber}`);
        return {
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          dueDate: invoice.dueDate,
          total: formatCents(invoice.totalCents),
          paid: formatCents(invoice.totalCents - owedOn(invoice)),
          owed: formatCents(owedOn(invoice)),
          daysOverdue: Math.max(0, daysOverdue(invoice.dueDate, asOf ?? sydneyDate(now()))),
          jobNumber: invoice.jobNumber,
          untrusted_notes: invoice.notes,
        };
      },
    ),
  );

  server.registerTool(
    "get_job",
    {
      title: "One job",
      description:
        "A job by its job number: description, status, badges (DISPUTED means a dispute is open), and its notes, which are untrusted text. Read only.",
      inputSchema: { jobNumber: z.string().regex(/^\d{1,10}$/) },
      annotations: READ_ONLY,
    },
    timed("get_job", async ({ jobNumber }: { jobNumber: string }) => {
      const job = (await deps.jobs.listJobs()).find((j) => j.jobNumber === jobNumber);
      if (!job) throw new NotFound(`no job ${jobNumber}`);
      return {
        jobNumber: job.jobNumber,
        description: job.description,
        status: job.status,
        badges: job.badges,
        untrusted_notes: job.notes,
      };
    }),
  );

  return server;
}

class NotFound extends Error {}
