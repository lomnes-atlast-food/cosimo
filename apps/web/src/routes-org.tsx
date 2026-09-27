import { type AnyRoute, createRoute, redirect } from "@tanstack/react-router";
import { AccountsPage } from "./pages/accounts";
import { BankAccountsPage, ImportPage } from "./pages/bank-accounts";
import { BillPage, BillsPage, NewBillPage } from "./pages/bills";
import { CategorizePage } from "./pages/categorize";
import { ContactsPage } from "./pages/contacts";
import { EntriesPage, EntryPage, NewEntryPage, validateEntrySearch } from "./pages/entries";
import { InvoicePage, InvoicesPage, NewInvoicePage, RecurringPage } from "./pages/invoices";
import { OpeningBalancesPage } from "./pages/ledger-settings";
import { ReconcileListPage, ReconcilePage } from "./pages/reconcile";
import { ReportsPage, validateReportSearch } from "./pages/reports";
import { ReviewQueuePage } from "./pages/review";
import { RulesPage } from "./pages/rules";

const msgSearch = (s: Record<string, unknown>) => ({ msg: typeof s.msg === "string" ? s.msg : undefined });

/** Org-scoped feature routes, added phase by phase. */
export function orgChildRoutes(parent: AnyRoute): AnyRoute[] {
  const r = (
    path: string,
    component: () => React.ReactNode,
    validateSearch?: (s: Record<string, unknown>) => object,
  ) => createRoute({ getParentRoute: () => parent, path, component, validateSearch }) as unknown as AnyRoute;
  return [
    r("/accounting/accounts", AccountsPage),
    r("/accounting/opening-balances", OpeningBalancesPage),
    r("/accounting/entries", EntriesPage, validateEntrySearch),
    r("/accounting/entries/new", NewEntryPage),
    r("/accounting/entries/$entryId", EntryPage, msgSearch),
    r("/reports", ReportsPage, validateReportSearch),
    r("/banking/accounts", BankAccountsPage),
    r("/banking/import", ImportPage, (s) => ({
      account: typeof s.account === "string" ? s.account : undefined,
    })),
    r("/banking/categorize", CategorizePage, (s) => ({
      account: typeof s.account === "string" ? s.account : undefined,
      status: typeof s.status === "string" ? s.status : undefined,
    })),
    // The page was called "Bank review" until it was renamed; keep old bookmarks working.
    createRoute({
      getParentRoute: () => parent,
      path: "/banking/review",
      beforeLoad: ({ location }) => {
        throw redirect({ href: location.href.replace("/banking/review", "/banking/categorize") });
      },
    }) as unknown as AnyRoute,
    r("/banking/rules", RulesPage),
    r("/banking/reconcile", ReconcileListPage),
    r("/banking/reconcile/$reconId", ReconcilePage),
    r("/accounting/review", ReviewQueuePage),
    r("/sales/invoices", InvoicesPage),
    r("/sales/invoices/new", NewInvoicePage),
    r("/sales/invoices/$invoiceId", InvoicePage),
    r("/sales/recurring", RecurringPage),
    r("/sales/customers", () => <ContactsPage kind="customer" />),
    r("/expenses/bills", BillsPage),
    r("/expenses/bills/new", NewBillPage),
    r("/expenses/bills/$billId", BillPage),
    r("/expenses/vendors", () => <ContactsPage kind="vendor" />),
  ];
}
