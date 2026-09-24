/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as accountSwitches from "../accountSwitches.js";
import type * as adminInvite from "../adminInvite.js";
import type * as analytics from "../analytics.js";
import type * as auditLog from "../auditLog.js";
import type * as auth from "../auth.js";
import type * as businesses from "../businesses.js";
import type * as clientContacts from "../clientContacts.js";
import type * as clients from "../clients.js";
import type * as crons from "../crons.js";
import type * as customTemplates from "../customTemplates.js";
import type * as dashboard from "../dashboard.js";
import type * as deliveries from "../deliveries.js";
import type * as demo_cleanup from "../demo/cleanup.js";
import type * as demo_clients from "../demo/clients.js";
import type * as demo_images from "../demo/images.js";
import type * as demo_jobs from "../demo/jobs.js";
import type * as demo_notes from "../demo/notes.js";
import type * as demo_reports from "../demo/reports.js";
import type * as demo_seed from "../demo/seed.js";
import type * as demo_shared from "../demo/shared.js";
import type * as demo_team from "../demo/team.js";
import type * as demo_templates from "../demo/templates.js";
import type * as email from "../email.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as jobs from "../jobs.js";
import type * as lib_abn from "../lib/abn.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_capabilities from "../lib/capabilities.js";
import type * as lib_clientScope from "../lib/clientScope.js";
import type * as lib_colours from "../lib/colours.js";
import type * as lib_contactNames from "../lib/contactNames.js";
import type * as lib_dates from "../lib/dates.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_emailConfig from "../lib/emailConfig.js";
import type * as lib_forecastWindow from "../lib/forecastWindow.js";
import type * as lib_inviteTokens from "../lib/inviteTokens.js";
import type * as lib_jobAccess from "../lib/jobAccess.js";
import type * as lib_jobScope from "../lib/jobScope.js";
import type * as lib_jobStatus from "../lib/jobStatus.js";
import type * as lib_membershipFacts from "../lib/membershipFacts.js";
import type * as lib_metNorway from "../lib/metNorway.js";
import type * as lib_noteAccess from "../lib/noteAccess.js";
import type * as lib_noteTemplates from "../lib/noteTemplates.js";
import type * as lib_optionSets from "../lib/optionSets.js";
import type * as lib_phone from "../lib/phone.js";
import type * as lib_postcodes from "../lib/postcodes.js";
import type * as lib_prices from "../lib/prices.js";
import type * as lib_recipients from "../lib/recipients.js";
import type * as lib_recurrence from "../lib/recurrence.js";
import type * as lib_reportContext from "../lib/reportContext.js";
import type * as lib_reportEmail from "../lib/reportEmail.js";
import type * as lib_reportFacts from "../lib/reportFacts.js";
import type * as lib_reportSearch from "../lib/reportSearch.js";
import type * as lib_richText from "../lib/richText.js";
import type * as lib_siteContact from "../lib/siteContact.js";
import type * as lib_svix from "../lib/svix.js";
import type * as lib_templateSnapshot from "../lib/templateSnapshot.js";
import type * as lib_workOrder from "../lib/workOrder.js";
import type * as memberships from "../memberships.js";
import type * as migrations_accessV3 from "../migrations/accessV3.js";
import type * as migrations_jobStatusV1 from "../migrations/jobStatusV1.js";
import type * as migrations_memberColoursV1 from "../migrations/memberColoursV1.js";
import type * as migrations_notesV2 from "../migrations/notesV2.js";
import type * as migrations_propertyFixesV1 from "../migrations/propertyFixesV1.js";
import type * as migrations_recurringIntervalV1 from "../migrations/recurringIntervalV1.js";
import type * as migrations_reportSnapshotsV1 from "../migrations/reportSnapshotsV1.js";
import type * as migrations_reportsContract from "../migrations/reportsContract.js";
import type * as migrations_reportsLibrary from "../migrations/reportsLibrary.js";
import type * as notes from "../notes.js";
import type * as notesSync from "../notesSync.js";
import type * as optionSets from "../optionSets.js";
import type * as properties from "../properties.js";
import type * as recurrences from "../recurrences.js";
import type * as reportAnnotations from "../reportAnnotations.js";
import type * as reportPdf from "../reportPdf.js";
import type * as reportPipeline from "../reportPipeline.js";
import type * as reports from "../reports.js";
import type * as snippets from "../snippets.js";
import type * as team from "../team.js";
import type * as templateSettings from "../templateSettings.js";
import type * as viewAs from "../viewAs.js";
import type * as views from "../views.js";
import type * as weather from "../weather.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  accountSwitches: typeof accountSwitches;
  adminInvite: typeof adminInvite;
  analytics: typeof analytics;
  auditLog: typeof auditLog;
  auth: typeof auth;
  businesses: typeof businesses;
  clientContacts: typeof clientContacts;
  clients: typeof clients;
  crons: typeof crons;
  customTemplates: typeof customTemplates;
  dashboard: typeof dashboard;
  deliveries: typeof deliveries;
  "demo/cleanup": typeof demo_cleanup;
  "demo/clients": typeof demo_clients;
  "demo/images": typeof demo_images;
  "demo/jobs": typeof demo_jobs;
  "demo/notes": typeof demo_notes;
  "demo/reports": typeof demo_reports;
  "demo/seed": typeof demo_seed;
  "demo/shared": typeof demo_shared;
  "demo/team": typeof demo_team;
  "demo/templates": typeof demo_templates;
  email: typeof email;
  http: typeof http;
  invitations: typeof invitations;
  jobs: typeof jobs;
  "lib/abn": typeof lib_abn;
  "lib/access": typeof lib_access;
  "lib/actor": typeof lib_actor;
  "lib/audit": typeof lib_audit;
  "lib/capabilities": typeof lib_capabilities;
  "lib/clientScope": typeof lib_clientScope;
  "lib/colours": typeof lib_colours;
  "lib/contactNames": typeof lib_contactNames;
  "lib/dates": typeof lib_dates;
  "lib/email": typeof lib_email;
  "lib/emailConfig": typeof lib_emailConfig;
  "lib/forecastWindow": typeof lib_forecastWindow;
  "lib/inviteTokens": typeof lib_inviteTokens;
  "lib/jobAccess": typeof lib_jobAccess;
  "lib/jobScope": typeof lib_jobScope;
  "lib/jobStatus": typeof lib_jobStatus;
  "lib/membershipFacts": typeof lib_membershipFacts;
  "lib/metNorway": typeof lib_metNorway;
  "lib/noteAccess": typeof lib_noteAccess;
  "lib/noteTemplates": typeof lib_noteTemplates;
  "lib/optionSets": typeof lib_optionSets;
  "lib/phone": typeof lib_phone;
  "lib/postcodes": typeof lib_postcodes;
  "lib/prices": typeof lib_prices;
  "lib/recipients": typeof lib_recipients;
  "lib/recurrence": typeof lib_recurrence;
  "lib/reportContext": typeof lib_reportContext;
  "lib/reportEmail": typeof lib_reportEmail;
  "lib/reportFacts": typeof lib_reportFacts;
  "lib/reportSearch": typeof lib_reportSearch;
  "lib/richText": typeof lib_richText;
  "lib/siteContact": typeof lib_siteContact;
  "lib/svix": typeof lib_svix;
  "lib/templateSnapshot": typeof lib_templateSnapshot;
  "lib/workOrder": typeof lib_workOrder;
  memberships: typeof memberships;
  "migrations/accessV3": typeof migrations_accessV3;
  "migrations/jobStatusV1": typeof migrations_jobStatusV1;
  "migrations/memberColoursV1": typeof migrations_memberColoursV1;
  "migrations/notesV2": typeof migrations_notesV2;
  "migrations/propertyFixesV1": typeof migrations_propertyFixesV1;
  "migrations/recurringIntervalV1": typeof migrations_recurringIntervalV1;
  "migrations/reportSnapshotsV1": typeof migrations_reportSnapshotsV1;
  "migrations/reportsContract": typeof migrations_reportsContract;
  "migrations/reportsLibrary": typeof migrations_reportsLibrary;
  notes: typeof notes;
  notesSync: typeof notesSync;
  optionSets: typeof optionSets;
  properties: typeof properties;
  recurrences: typeof recurrences;
  reportAnnotations: typeof reportAnnotations;
  reportPdf: typeof reportPdf;
  reportPipeline: typeof reportPipeline;
  reports: typeof reports;
  snippets: typeof snippets;
  team: typeof team;
  templateSettings: typeof templateSettings;
  viewAs: typeof viewAs;
  views: typeof views;
  weather: typeof weather;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  prosemirrorSync: import("@convex-dev/prosemirror-sync/_generated/component.js").ComponentApi<"prosemirrorSync">;
};
