# Project brief: CRM migration to the cloud

**Sponsor:** Chief Commercial Officer
**Program manager:** Shakhriyor
**Target start:** 2026-11-02
**Hard deadline:** the legacy CRM licence expires on 2027-03-31.

## Background

Our sales and support teams (about 120 users across Tashkent and Samarkand) use an
on-premises CRM installed in 2014. It runs on a single server that is out of vendor
support, has no API, and is integrated with the billing system through a nightly CSV
export. We want to move to a cloud CRM (vendor already selected) before the licence ends.

## Goals

1. Migrate customer, contact, deal and ticket history (about 400k records, 11 years).
2. Replace the CSV export with an API integration to billing.
3. Train all users and switch off the legacy system by 2027-03-15 at the latest.
4. Keep customer data in-country to meet local data-residency rules.

## Constraints and known facts

- Internal team: 1 program manager, 2 developers, 1 business analyst, 1 part-time DBA.
- The vendor provides a migration consultant for 20 days.
- Sales has a quarter-end freeze from 2026-12-20 to 2027-01-10: no cutover in that window.
- Data quality is poor: an estimated 15% of contacts are duplicates.
- Budget is approved; change requests above 10% need steering-committee approval.

## Out of scope

- Marketing automation (phase 2).
- Changes to the billing system itself.
