/**
 * Everything the worker runs that registers itself when its module is imported: the assist kinds' input, completion
 * and removal checks, and every storage job handler, final-failure hook and daily task. The worker imports this one
 * module; registrations.test.ts checks that no registering module is left out.
 */
// Register the report and summary kinds' input, completion and removal check with the assist runner.
import '../assist/reports.service';
import '../assist/summaries.service';
// Register the source-area handlers (store-source, backfill-sources) and their daily tick.
import '../storage/sources';
// Register the daily source-file check.
import '../storage/source-files';
// Register the file-output handler, its final failure and the daily drop of unfiled output bytes.
import '../outputs/filing';
// Register the output file check job and the daily output check.
import '../outputs/checks';
// Register folder sharing (share-sync, place-output), its final failure notice and the daily reconciliation.
import '../outputs/sharing';
// Register withholding held files (withhold, restore-withheld), its final-failure notice and the daily retry.
import '../storage/withhold';
// Register relocating stored files (relocate), its final failure and the daily retry and move completion.
import '../storage/relocate';
// Register renaming an output's folder and files after its title is cleaned or restored.
import '../outputs/rename';
// Register moving a project's folders into its new owning department (transfer-folders) and its final failure.
import '../projects/department-transfer';
// Register the daily source-area access check (the "also open to" warning, and storage Administrators' folder and grant).
import '../storage/source-area-access';
// Register the daily library permission check of approved output destinations.
import '../storage/destination-library';
