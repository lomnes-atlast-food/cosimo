ALTER TABLE `organizations` ADD `is_sample` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `organizations` SET `is_sample` = 1 WHERE `name` = 'Demo Studio (sample data)';