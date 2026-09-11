/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analytics from "../analytics.js";
import type * as auditLog from "../auditLog.js";
import type * as auth from "../auth.js";
import type * as businesses from "../businesses.js";
import type * as clientContacts from "../clientContacts.js";
import type * as clients from "../clients.js";
import type * as crons from "../crons.js";
import type * as customTemplates from "../customTemplates.js";
import type * as dashboard from "../dashboard.js";
import type * as email from "../email.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_colours from "../lib/colours.js";
import type * as lib_dates from "../lib/dates.js";
import type * as memberships from "../memberships.js";
import type * as notes from "../notes.js";
import type * as properties from "../properties.js";
import type * as recurrences from "../recurrences.js";
import type * as reportAnnotations from "../reportAnnotations.js";
import type * as reportPdf from "../reportPdf.js";
import type * as reports from "../reports.js";
import type * as viewAs from "../viewAs.js";
import type * as weather from "../weather.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analytics: typeof analytics;
  auditLog: typeof auditLog;
  auth: typeof auth;
  businesses: typeof businesses;
  clientContacts: typeof clientContacts;
  clients: typeof clients;
  crons: typeof crons;
  customTemplates: typeof customTemplates;
  dashboard: typeof dashboard;
  email: typeof email;
  http: typeof http;
  jobs: typeof jobs;
  "lib/access": typeof lib_access;
  "lib/colours": typeof lib_colours;
  "lib/dates": typeof lib_dates;
  memberships: typeof memberships;
  notes: typeof notes;
  properties: typeof properties;
  recurrences: typeof recurrences;
  reportAnnotations: typeof reportAnnotations;
  reportPdf: typeof reportPdf;
  reports: typeof reports;
  viewAs: typeof viewAs;
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
};
