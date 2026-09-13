# Form Specification & Data Dictionary: Pest M8 Service Report

## 1. Form Header & Operational Metadata
* **Form Name:** Pest M8 Service Report
* **Form Status:** In Progress / Draft / Submitted
* **Date:** DD MMM YYYY (Default: Current Date)
* **Client Name:** Single-line text input
* **Site Address:** Single-line text input / Address lookup
* **GPS Coordinates:** Telemetry fields (Latitude, Longitude, Altitude)
* **Report Cover Photo:** Image uploader (1 Landscape Photo)
* **Client Phone:** Phone text input
* **Client Email:** Email text input
* **Send copy to client upon submission:** Toggle (Yes / No)
* **Start Time:** Time picker
* **Finish Time:** Time picker
* **Weather on the Day:** Multi-select checkboxes
  - Overcast
  - Wet
  - Sunny
  - Windy
  - Evening

---

## 2. Treatment, Product(s) & Quantities Applied (Dynamic Grid / Repeater)

### Column 1: Treatment (Checkboxes)
- General Pest Control
- EOL (End Of Lease Flea Treatment)
- Ant Full Block Spray
- Ant Spot Spray
- Spider Spray External
- Cockroach Treatment
- German Cockroach Treatment
- Rodents
- Cockroach & Rodents
- Rodent Bait Top-Up
- Live Termites
- Wasps
- Other

### Column 2: Product & Active Ingredient (Checkboxes)
- Biflex Ultra (100 g/L Bifenthrin)
- Fipforce HP (100 g/L FIPRONIL)
- Seclira WSG (400 g/kg DINOTEFURAN)
- Sumilarv IGR (20 g/L PYRIPROXYFEN)
- Ditrac All Weather Blox (0.05 g/kg Bromadiolone)
- Advion Cockroach Gel AEPMA (6g/kg Indoxacarb)
- Stardust Pro (20 g/kg Permethrin 40:60 5 g/kg Triflumuron)
- Couma (0.37 g/Kg COUMATETRALYL)
- Advion Ant Gel (0.5 g/Kg Indoxacarb)
- Biflex Aqua Max (100 g/L Bifenthrin)
- Clear-Out Crawling Insect Aerosol (0.6 g/kg Fipronil)
- Generation First Strike Soft Baits (0.025 g/Kg Difethialone)
- Termidor Foam Termiticide & Insecticide (0.05 g/kg Fipronil)

### Column 3: Quantity of Chemicals Used (Checkboxes)
- 100ml/10L
- 60ml/10L
- 20ml/2L
- 20g/5 Litres
- 1-5 grams
- Bait Blocks

### Column 4: Chemical Application Method (Checkboxes)
- Hand Held Battery Operated Sprayer
- Hand Compression Sprayer
- Vehicle Mounted Sprayer
- Dusting with Blower in Roof Space
- Dusting
- Gels applied with Gel Gun
- Misting with Backpack
- Bait Applied in Bait Stations
- SGARS in compliance with the new 35 day ruling
- Will revisit and collect bait in accordance with new legislation

*Grid Repeater Actions:* [Delete Row], [Add Row]

---

## 3. Risk Assessment Module

### Risks Present (Checkboxes + Runtime User Input Addition)
- People/Children
- Animals / Birds / Fish
- No Risk Safe Access Given
- No Risk Property Empty
- Pool
- Obstructions on the Ground
- [User Extensible Text Input: Add dynamic item]

### Action Taken to Eliminate Risk (Checkboxes + Runtime User Input Addition)
- Informed people/children to vacate the area or stay indoors
- Moved Animals or Birds to an unaffected part of the property
- Client Took Pets off Property
- Client Kept Pets Inside
- Safe access given
- [User Extensible Text Input: Add dynamic item]

### Safety Compliance Toggles (Yes / No Toggles)
- Spill Kit Available
- MSDS on site
- PPE (for Technicians)
- Chemicals locked up and stored after use
- First Aid Kit on site
- Signage Displayed showing Chemicals being applied out Front
- Additional action taken to eliminate any risk was: Text area input
- Is it safe to commence work?: Yes / No toggle (Mandatory gate)

---

## 4. Technician Recommendations & Sign-Off

### Housekeeping Recommendations (Checkboxes + Runtime User Input Addition)
- Regular Maintenance required to keep under control
- Rubbish Removal
- Eliminate food sources in kitchen for cockroaches and ants
- Clean bins
- [User Extensible Text Input: Add dynamic item]

### Freeform & Select Inputs
- Treatment Limitations: Multi-line text input
- Technician's Comments: Multi-line text input
- Next Visit Due In: Dropdown menu (`1 Week`, `2 Weeks`, `3 Weeks`, `35 Days`, `1 Month`, `2 Months`, `3 Months`, `3-6 Months`, `6 Months`, `10 Months`, `12 Months`, `6-12 Months`)
- Technician Name / License: Radio selector (`Terence Van Der Walt (Licence 11132)`, `Kevin Edgar (Licence 4132)`)
- Technician Signature: Touch/Mouse signature canvas pad
- Customer Signature: Touch/Mouse signature canvas pad
- Add Photos?: Toggle (`Yes` / `No`)
- Email Report To: Email input field (Triggers automated PDF dispatch)

---

## 5. Embedded Legal Notices & Expectations (Static Text)

### Standard Warranty Guidelines
- All Australian Chemicals have a **3 Month Warranty** when sprayed.
- Effective duration ranges from **6 to 12 months** based on environmental conditions.
- **6-Week Flush-Out Period:** Pests will flush out and die upon contact with treated surfaces for up to 6 weeks.
  - 1 Month post-treatment: ~2 days to die after contact
  - 2 Months post-treatment: ~4–6 days to die after contact
  - 3 Months post-treatment: ~6–8 days to die after contact

### Pest Wait Times & Expectations
* **General Pests (6 Weeks):** Includes cockroaches, webbing spiders, redbacks, carpet beetles, silverfish, crickets, wasp nests. Insects must touch surface; does not work by odor.
* **German Cockroaches (6 Weeks):** 70–80% reduction in Week 1. Total elimination by Week 6.
* **Spiders (6 Weeks):** 80–90% reduction around windows; 90–100% reduction for Red Backs.
* **Ants (6 Weeks):** Activity expected up to 3 weeks while bait is transferred back to colony.
* **Rats / Mice (4 Weeks):** Initial activity increase due to bait attraction. Roof noises subside over 3–4 weeks. Do not seal entries until resolved.
* **Fleas (3–4 Weeks):** Daily vacuuming required to stimulate hatching; repeat treatment may be needed.