-- Per-customer default invoice terms (#66): used for new invoices before the org default.

ALTER TABLE `contacts` ADD `default_terms` text;
