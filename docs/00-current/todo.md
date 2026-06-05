To-do for today "Product Finder": 
1. we are going to generalize the table component of the product finder. Some things I want to adjust:
- I want the columns sortable.
- I want an option to add and remove columns.
- I also want to add pagination. 

2. Audit of the Gransier tab working fine Working fine and need some small adjustments. 
3. Audit of the Kruitbosch tab, It's implemented, but due to credential problems yesterday, it's not been tested, and currently it's not working at all, so we need to debug.   
4. Audit of the sync methods. The Gransir Sync Catalog is working fine. The KruitBosch Sync Catalog is not 



Nice to have: continue working on our maestro autonomous script.
1.Create New Task intake flow 
- Context scout
- Context reducer
- Plan maker
- Slice maker
- Build review loop






TMUXXEN 


So today I want to work on my mastro automation autonomous script, just to be certain we don't mess things up. I've created a copy of the maestro_dev, since mastro is currently in use. 

 Currently we have a hard-coded autonomous flow that has to change to something more dynamic. We have two loops:
1. The autonomous loop (the hard-coded one)
2. I think it's in the flow engine, then we loop over our flow JSON file. In that JSON file, we define the skills we want to use and what they should do on a certain event (success, reject, or whatever).
I want to make some sort of pipeline where I can put in agents and loops and whatever, something like that. One big important thing is the prompt builder. I need to have a clear flow of prompt generation in the flow, and also I want to make sure the skill is used correctly and the correct context is loaded as well.
I also want to beautify the UI or CLI output or terminal output, whatever you want to call it, something more colorful so I can see clearly the different steps. I also want that to be more dynamic, so all the info will come out of the pipeline manager, whatever the hell. Let's do some Q&A about it.



Okay, everything is implemented, but there are some issues. 
1.On the DST supplier tab, the search field isn't using the EAN lookup anymore. I get an error. I'll show it.
[1] --> GET /api/product-finder/search?q=452466714565&supplier=dst&page=0&size=20 500 1ms

2.On the Create Kruitbosch tab, when syncing the catalogue, I get the following errors. 
 <-- POST /api/product-finder/sync/kruitbosch                                                             
[1] [Kruitbosch Sync] Starting catalog download...
[1] [Kruitbosch Sync] Downloaded catalog (8468782 bytes)
[1] [Kruitbosch Sync] Column mapping — EAN:0, Name:0, Brand:undefined, Model:undefined, RetailPrice:0, PurchasePrice:undefined, Image:0, ItemNumber:undefined
[1] [Kruitbosch Sync] Processing 17581 products...
[1] [Kruitbosch Sync] Error: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint
[1] --> POST /api/product-finder/sync/kruitbosch 200 3s

3. Kruitbosch_Supplier Doesn't exist yet.

4.On the gransier tab, the images aren't shown. 
Commercial information:
URL, ExpDelTime, PosImages, Colour, ShortDescription, LongDescription, 
LongDescriptionHTML, VideoURL

It should be one of those. I'm not sure, maybe POS images or URL. I don't know. 

I want to think of a label system I want to use the issues for PRD, but currently I only have parent PRD. The parent PRD can connect to some issues, but the labels I currently have are not sufficient. I need one for bugs, and I need small, medium, urgent, like some statuses and some flow labels, but not too much so it stays clear. Can you suggest some label system, for example an implementation flow or bug fixing, or you name it? 


So my current flow goes as follows:
1. I write a prompt with an ID, an issue, a bug. It can be anything.
2. I use that prompt with the grill me skill, so we do a little Q&A about the topic.
3. I write a PRD from it.
4. I create slices from it with the two issues skill, and those slices get published on GitHub.

So all those steps are currently manual steps. The only autonomous thing I currently have is the builder reviewer group. What happens is:
1. The first check is to find the parent PRD so it can be added to the context.
2. And then it basically loops over all the issues that need triage because that's the label getting checked for, so even the ready for agent and ready for human labels aren't used yet. 

But my new pipeline system will be much better. How should my new flow look? Instead of doing everything manually, I will create issues for everything with a specific label, and then those issues will be picked up by the correct flow. Those flows and those labels I need 









Before we execute something of this plan, we need to make sure the current documentation and the current MD files are not pointing to the old feature system. We have to check systemmd, agentmd, contextmd, and all the other important MD files pointing to the feature implementation. We have to change that First, before we implement or refactor something, otherwise during implementation the agents will receive sometimes the wrong information and will try to re-implement the feature structure again.


Since we are using agentic coding, it's not necessary to preserve a lot of the files or do a refactor. The only thing that I want to keep is the current implementation of product finder, but since it's a feature implementation, we can leave it as is. We can keep the product finder and make a separate refactor from it later on. First, We can now focus on restructuring everything else and then do a rewrite of the current functionality, but it's not a lot we have, so I think it would be easy. 


Q1: Only make adjustments to DST art when needed. 

Q2: The bicycle and labor services are not working currently as expected, so for now they just can go. I will remake them later. 


What is the command in Linux to copy the directory Recursively? 



 I want to create a high-level map of our project and all the things that need to be done, but high-level. For example, some sort of road map of things I can restructure it sometimes and add ideas and thoughts to it, yeah, something like that. 


 Task: Create a high-level project roadmap / master map of all outstanding work.
   Goal: Produce a living, flexible overview of everything that needs to be done across
 the project.
   Context: This is for a TypeScript/POS project (pi-pos-v1). The user wants a
 strategic view, not implementation details.

   Scope:
   - Group work into high-level categories or phases (e.g., "Core Infrastructure",
 "Feature Gaps", "Refactoring", "Nice-to-Haves").
   - Include known todos, open issues, and any obvious gaps from the codebase
 structure.
   - Keep descriptions brief — one line per item max.

   Non-goals:
   - No implementation details or technical specs.
   - No priority scoring unless obviously critical.
   - Do not invent work items that aren't supported by evidence in the repo.

   Process:
   1. Scan the project structure, open issues, TODOs, and docs/ folder for hints about
 known gaps or planned work.
   2. Group findings into logical high-level buckets.
   3. Present as a clean markdown outline that's easy to edit, reorder, and annotate.

   Output format: A markdown document with category headings and bullet-point items
 underneath. Leave room for the user to add notes (e.g., `[TODO: add note]`). Stop when
 all obvious work areas are covered.



 
Automation Flow

What i do.

 1.Create an issue with a good explenation of a bug or error -> Label Bug 
 2.Create an issue with a change enhancement, or new feature -> Needs Triage 



Maestro loop 

1.Reads the open issues on github per label and list them.

Bugs: 

1.Agent that finds the problem and creates an implementation plan for it 







Currently we have our post flow implemented, but it has some failures, so we have to check it and form a plan to implement a good working flow.
Things I want:
- I want a handy scan input field. That's a must-have.
- I also want to be able to search in our catalog and select an item from there.
- I also want to be able to create a product that's not in stock but not in our catalog (for example, something that was lying around that I want to sell), and it's called the special or a shelf stock item. I don't know how it's called, but it's a custom product to sell.
- I don't need a drop-down for the customers or select books like that. I want also an input field so I can search by name, and it should complete some sort of list.
- The point of sale is only to create the order. Let's see, but the payment is a separate component, because later we are going to use it for orders and for repairs, so it has to be separate.

   


  Task: Plan and implement a robust, multi-modal order entry flow for the Pi POS system that
 replaces the current broken parts search + customer selector with a polished, keyboard-friendly
 experience.

   Goal: Deliver a working order entry screen where cashiers can add items via barcode scan or
 catalog search, select customers by typed autocomplete, optionally create ad-hoc "special"
 products on-the-fly, and keep payment as a separate step for future reuse (repairs, etc.).

   Context:
   - Pi POS is a bicycle shop point-of-sale system with React 18 frontend + Hono backend +
 SQLite.
   - Current `PartsSearch` component has two separate inputs (barcode + text) that both call GET
 /api/parts?search=. The barcode input tries to add on blur/Enter but the UX is clunky.
   - Current `CustomerSelector` loads ALL customers into a scrollable button list with no search
 capability — slow and unusable at scale.
   - PaymentForm is embedded in PosPage alongside customer selector; user wants it decoupled.
   - Backend currently requires partId for every line item (cartLineItemSchema has required
 partId). No support for ad-hoc products.
   - Line items have `lineType: 'part' | 'labor' | 'bicycle'` in the DB schema, but only 'part'
 is used in practice.

   Scope:
   1. **Unified search input** — One input field that handles both barcode scanning (exact match
 on Enter/blur from keyboard wedge) and text search (debounced partial-match by name/SKU). Show
 results as a compact dropdown/list below the input, not a separate panel.
   2. **Catalog item selection** — Clicking or pressing Enter on a catalog result adds it to cart
 immediately. The input clears for next scan/search.
   3. **"Special" / ad-hoc product creation** — A way (button or keyboard shortcut) to open an
 inline form or modal to create a temporary product with: name, price, VAT rate. This creates a
 part with quantityOnHand=1 (or unsold-once flag) and adds it to cart. The created part appears
 in the catalog for future use.
   4. **Customer autocomplete** — Replace the button-list CustomerSelector with an input field
 that calls GET /api/customers?search=<typed> (needs new backend endpoint), shows a dropdown of
 matching customers, and allows selection by click or arrow+Enter. Walk-in remains available as
 "None selected" state.
   5. **Payment separation** — Extract PaymentForm into its own component/module that receives
 cart total and line items as props, returns payment method + details. It is NOT embedded in
 PosPage layout; it's a callable component (e.g., `showPaymentDialog()` or render on demand).

   Non-goals:
   - Do not change the checkout API contract for existing part-based sales.
   - Do not implement repair flow (that's future work — just architect payment to support it).
   - Do not modify stock movement logic, sequence numbering, or voiding behavior.
   - Do not add new database migrations unless absolutely necessary (ad-hoc parts can use
 existing parts table with a flag or quantityOnHand=0 sold-once pattern).

   Process:
   1. Audit the current POS flow — identify all failure points in PartsSearch, CustomerSelector,
 and checkout path.
   2. Design the unified search input component (barcode + text in one field).
   3. Design the customer autocomplete component (needs new backend endpoint GET
 /customers?search=).
   4. Design the "special product" creation flow (inline form or modal + API).
   5. Plan payment decoupling — define the PaymentForm interface and how PosPage calls it.
   6. Create implementation tickets with clear acceptance criteria.

   Output format: A structured plan document with:
   - Section 1: Current failure analysis (what's broken, why)
   - Section 2: Component design for each of the 5 areas above
   - Section 3: API changes needed (new endpoints, schema updates)
   - Section 4: Implementation phases ordered by dependency
   - Section 5: Acceptance criteria per phase

   Stop condition: Plan is complete enough that a builder agent can start implementing without
 further clarification.
 

 1. All of Flanders
2. When entering postal code city should be searched, once selected city, the streets should be suggested.




Implementation report of POS:

## Input/Selecting Data
- Scanning an item via barcode or searching an item via barcode. When a barcode is not found, an error should be shown.
- The search part by name that works correctly.
- On the point of sale, I also need to be able to change the VAT percentage.
- When searching for a customer by name, the email address and phone show up, but the name also should be visible in the small drop-down thingy when you start to type.
- Once the name is selected, we should see more info like:
    - name
    - address (if available)
    - telephone number

## Flow Create Special Product 
- Everything is ok

## Payment Flow on click pay 
- When a payment method is selected, it should be visible which one is selected. 
- When I try to complete the sale, an error shows up with the message: "Check out failed: insufficient stock." While, there was enough stock, but I think I know the problem. The problem is some constraint that also looks to the movement table and the item on stock. We don't have any way to insert new items that also generate a movement. Currently, when I raise the stock of an item, I go to our product catalog and I change the numbers over there, but when I do that, there is no movement created. I think that is the reason why the check out fails because of the insufficient stock. 
- On the other hand, when I use only a special product, then the payment gives no error and the sale is made. 


### Goal 
Verify the issues above and form a plan to investigate the code.





## Customers 
- Connect the street; city input fields to our adress table 
- address_streets is currently empty. 

### Goal 
Verify the issues above and form a plan to investigate the code.



### Repairs 

###


/skill:grill-with-docs When adding a new customer and entering something in the postal code
input field. It loads and the text no results shows
 --> GET /api/postal-codes?search=9000 [{"code":"9000","name":"GENT","municipality":"GENT"}] 

 Maybe add debug information then we can easely pinpoint the error. 





http://192.168.0.136:3000/api/postal-codes?search=9090
[{"code":"9090","name":"Gontrode/MELLE","municipality":"Gontrode/MELLE"}]


http://192.168.0.136:3000/api/address-streets?postalCode=9090&search=scha
[{"name":"Schauwegemstraat","municipality":"Merelbeke-Melle","postalCode":"9090"},{"name":"Vlaschaard","municipality":"Merelbeke-Melle","postalCode":"9090"}]


### Repairs
1.Going through the intake flow
The only issue we have with the intake flow is that we cannot set a planned date and a pickup date. 

2.Going through the repair flow 

- So at that point, the customer is set. The bicycle is set. We know what to do on the bicycle, so then we need to start working on the bicycle. Before we can do that, we need to assign a worker. The thing is, we don't have a table yet for workers. 
- Once the worker is assigned, we can start the timer. When the timer is started, the repair status changes to in progress. When the timer is started, we should see a pause button and a stop button. The difference between the pause button and the stop button:
    - The pause button is used for a small break (going to the toilet, helping another customer).
    - The stop button means we stop working at this bike for the moment, or if it's done, so we can pick it up again another day or something like that.
    That's the difference between those.

- It should be possible to add lines. You can use the same way as we do it with our POS route. 
- The customer notes and the internal notes should be editable by the user/worker. 



### Goal 
Verify the issues/Enhancements from above and form a plan to investigate the code.


When a product moves, the movements are recorded in the stock movements table. When we adjust the amount in our stock, it gets flagged as an adjustment. If we import an item, a product, from the product finder, it gets noted. When we sell an item, it's also getting tracked.

The only thing that is persisted wrongly is the actual quantity on hand. On the other hand, when we try to sell an item that is not in stock anymore, when we try to pay, the payment window says there is an insufficient stock. Let's take a look at this.
So our system is able to track the correct stock, but just not in the stock table.  



And I also wanna know who is responsible for changing the labels on the issues. And what labels are used through the current application, or what types of labels are currently used in Maestro? 


First of all, we can use the RPC with a session dir mod, so we have the sessions in our maestro folder, so we could start with that. 

Starting RPC Mode
pi --mode rpc [options]
Common options:

--provider <name>: Set the LLM provider (anthropic, openai, google, etc.)
--model <pattern>: Model pattern or ID (supports provider/id and optional :<thinking>)
--no-session: Disable session persistence
--session-dir <path>: Custom session storage directory

Take a look at the following docs file. It's including the session format. 

https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md






Create a diagnostic prompt template based on the current templates in /home/david/projects/pi-pos-v1/.pi/maestro/prompts using the diagnostic skill. in the /home/david/projects/pi-pos-v1/.pi/maestro/flows/prd-to-issues-reviewer.json flow


I want to create a skill that is conform to the write a skill skill that reviews an issue and checks if the issue is self-contained enough to be given to a builder without knowledge beforehand, so starting with a clean context. 



/skill:python-implementer Implement issue 205. read the plan if you need extra info /home/david/projects/pi-pos-v1/.pi/maestro/REDESIGN_PLAN.md  and run dashboard.py to test if it works



I want to take a look at how data is passed through the sessions. We have a couple of options:
1. Our agents stream their content; we can capture that.
2. We can use the session logs.
If you take a look at the output of the console, you will see we check on verdict and that verdict is determined by the output of the session. I think we need to take a look at our session parser and go from there.

We also have to make sure that every template that is used in a flow states that the output must be a general schema. Currently, we make use of a JSON file that updates state. 

/home/david/projects/pi-pos-v1/.pi/maestro/README.md


output console :

🚀 Maestro — prd-to-issues-reviewer
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[INFO] Builder writes code, reviewer validates quality. Retry loops on rejection.
• Builder writes code, reviewer validates quality. Retry loops on rejection.
[START] Processing issue #209 with flow 'prd-to-issues-reviewer'

────────────────────────────────────────
🔍 Issue #209: Processing — — "[Dashboard Rewrite] Slice 10: Agents Roster + Global Features" 0 comment(s) created 2026-05-28
[PARENT] Issue #209 references parent PRD #199
[PARENT] Loaded parent PRD #199 (6850 chars)
[PHASE] Invoking skill: /skill:issue-readiness

============================================================
[DEBUG] Phase: issue-readiness | Issue: #209
[DEBUG] Template loaded: YES
[DEBUG]   {issue_number} = '209'
[DEBUG]   {diagnostic_insights} = ''
[DEBUG]   {previous_output} = ''
[DEBUG]   {prd_body} = '## Parent PRD (#199)

## Problem Statement
The current Maestro dashboard is a half-done prototype with a rigid 2-tab layout that fails to provide an effective operational view of the AI agent pipeline...'
[DEBUG]   {issue_body} = '## Issue #209

## Parent

#199 ([PRD] Maestro Dashboard — Complete Rewrite & Feature Expansion)

## What to build

Agents roster tab and global UX polish. Agents tab renders flow phases from `flows/*....'
[DEBUG]   Context preview: 'PRD (6872 chars) | '
[DEBUG] Prompt: 3393 chars, 89 lines
[DEBUG] First line: '## PHASE: issue-readiness'
============================================================

[PHASE] Running 'issue-readiness' on issue #209
[rpc] Session dir: /home/david/projects/pi-pos-v1/.pi/maestro/sessions/209/prd-to-issues-reviewer-issue-readiness-2026-05-28T14:46:06.jsonl
[rpc] Starting pi --mode rpc (model=qwen-35b-a3b-118k-bf16, provider=llama-cpp-3090, timeout=1800s)
[rpc] Sending prompt (3393 chars)
[rpc] Session log: /home/david/projects/pi-pos-v1/.pi/maestro/sessions/209/prd-to-issues-reviewer-issue-readiness-2026-05-28T14:46:06.jsonl/2026-05-28T14-46-07-306Z_019e6f0c-c0ca-7498-b693-0f6cdd9ade9d.jsonl
[rpc] SUCCESS (phase: issue-readiness)
[rpc] No verdict in session log, falling back to result file
[rpc] Reading result from: /home/david/projects/pi-pos-v1/.pi/maestro/state/slice-result.json
[PHASE] issue-readiness -> reject
├─ Attempt 1/3 | Phase: Issue-Readiness ⏳
   • 🤖 Model: llama-cpp-3090/qwen-35b-a3b-118k-bf16
   • ⏱️   Session lasted 2m 33s
   • 📄 File Operations: 19 written, 3 failed
[github] Posted comment on #209

   ↺ Feedback → Rejected
      └─ issue-readiness rejected: issue-not-ready
[PHASE] Invoking skill: /skill:archivist

============================================================
[DEBUG] Phase: archivist | Issue: #209
[DEBUG] Template loaded: YES
[DEBUG]   {issue_number} = '209'
[DEBUG]   {diagnostic_insights} = ''
[DEBUG]   {previous_output} = '## ISSUE-READINESS COMPLETED
issue-readiness rejected: issue-not-ready'
[DEBUG]   {prd_body} = '## Parent PRD (#199)

## Problem Statement
The current Maestro dashboard is a half-done prototype with a rigid 2-tab layout that fails to provide an effective operational view of the AI agent pipeline...'
[DEBUG]   {issue_body} = '## Issue #209

## Parent

#199 ([PRD] Maestro Dashboard — Complete Rewrite & Feature Expansion)

## What to build

Agents roster tab and global UX polish. Agents tab renders flow phases from `flows/*....'
[DEBUG]   Context preview: 'PRD (6872 chars) | ## ISSUE-READINESS COMPLETED
issue-readiness rejected: issue-not-ready'
[DEBUG] Prompt: 1997 chars, 52 lines
[DEBUG] First line: '## PHASE: archivist'
============================================================

[PHASE] Running 'archivist' on issue #209
[rpc] Session dir: /home/david/projects/pi-pos-v1/.pi/maestro/sessions/209/prd-to-issues-reviewer-archivist-2026-05-28T14:48:42.jsonl
[rpc] Starting pi --mode rpc (model=qwen-35b-a3b-118k-bf16, provider=llama-cpp-3090, timeout=900s)
[rpc] Sending prompt (1997 chars)
[rpc] Session log: /home/david/projects/pi-pos-v1/.pi/maestro/sessions/209/prd-to-issues-reviewer-archivist-2026-05-28T14:48:42.jsonl/2026-05-28T14-48-42-908Z_019e6f0f-209b-71a8-b8dd-c6fb1470645d.jsonl
[rpc] SUCCESS (phase: archivist)
[rpc] Verdict extracted from session log (/home/david/projects/pi-pos-v1/.pi/maestro/sessions/209/prd-to-issues-reviewer-archivist-2026-05-28T14:48:42.jsonl/2026-05-28T14-48-42-908Z_019e6f0f-209b-71a8-b8dd-c6fb1470645d.jsonl): approved
[PHASE] archivist -> success
├─ Attempt 2/2 | Phase: Archivist (retry) ⏳
   • 🤖 Model: llama-cpp-3090/qwen-35b-a3b-118k-bf16
   • ⏱️   Session lasted 4m 0s
   • 📄 File Operations: 24 written
✓ archivist approved (retry)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ All 1 issue(s) completed successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


LABELS voor de issues en hoe comments of edits consistent doen

### ########################################

Input velden valuta fixen 

euro's naar centen en centen naar euro's, of centen / euros gewoon doorspelen 


Templates van de fietsen bekijken 



### #######################################

model als input meegeven bij orchestration 

labels bekijken 

needs-triage -> need info > reviewed > ready for implementation > testen runnen > implementation reviewed


repair -> payment -> sales en  calender

orders + backorders

### #######################################


I've got two working flows in my maestro setup:
1. Builder reviewer flow
2. PRD to issue reviewer flow

And I also got a pipeline system in my maestro setup. What I want to do now is the PRD to issue reviewer flow: the first flow to be run, followed by the builder reviewer flow per issue, so that's the complete flow for one issue. 
And in that flow or in that pipeline, I want to set my labels for the issue. 

And then an issue starts with needs triage. After that, it goes to need info, then we need some sort of reviewed status. When the issue is reviewed and ready for implementation, then we implement. Then we check the implementation, and in between we run some tests as well. 



1.The pipeline starts from the needs triage issues. 
2.When there is a PRD present, it is stated in the issue. We have a script that checks whether or not there is a parent paragraph included in the issue. If that's the case, then the PRD is included in the context automatically. If an issue is getting reviewed, the reviewer also sees the PRD, so we don't have to worry about that. 
3.Yeah, the testing phase is just running the commands without an LLM, and the output is captured. If it fails, the pipeline will go back. What will happen if it fails? We have to discuss that. 
4.Currently, some of the label transitions happen in the skills, but I want the pipeline to handle the labels based on the outputs of the flows. Since we run it deterministically, we know if a certain step is accepted or rejected, and we can handle based on that. 
5.I want a system where I can put in one issue, several issues, or go full automatic with catching the issues with need triage labels. 


1.test failure behavior 
When the test runner fails, I should give the output to the builder, so option A. 
But indeed, your recommendation is a good option A for the first two retries, then option B diagnostic on the third failure. Yes, that looks good. 

2.PRD Review to Builder Handoff 
Yes, you are right. Single flow is way better than the chaining the flows. Now we focus on handling the labels and reading out the phases and steps of the JSON file, so the functionality of the pipeline will be more clean and more useful. 

3.Okay option C. What do you think is best? Currently the skills are handling everything with the
issues but I think it's better to handle the labels deterministically because there are still
checks involved with the out-of-the-agent. I think we will have a more consistent flow if we do
it deterministically. What do you think?


4.Can you check if context.py is used somewhere? /home/david/projects/pi-pos-v1/.pi/maestro/pipelines/context.py

Do not build yet, i want to review yur plan first. 


1.answer on  ❓ Question: Are we building against customerOrders, backorders, or do you want to consolidate them into one? Your verbal description
 sounds like ONE unified order concept.

Okay, we have several orders in our system.
What can be an order?
- If a customer comes to the shop and wants to buy a certain part that is not in stock, I have to order it. I have to create an order for the customer so I can ask for a deposit for the part so I can order it. This type of order is a customer order. Customer orders can be for a part or a bicycle.
- Then we have the repairs when a part is not in stock that we need for repairs, and we have to order it. That's also an order.
- Then the order we are doing as a shop with our suppliers. This one is called the back order.


2.Answer to the question: Deposit mechanism 
A deposit is a direct payment allocation to the order. 

3.Answer to the Leased Bicycles
Maybe it's a good idea to track a bicycle if it's a leased bicycle or not. 
We just need to decide where in the flow we add the lease tag to the bicycle. 

4.Answer to the question: Repair needs an order. 
Then I would go to create a backorder linked to the repair via the hold reason waiting part. 

5.Answer to the question: Deposit optional vs required? 
Since we sell leased bikes as well, we can't ask for a deposit. 

You can also take a look at the following issues:
- Issue 227
- Issue 241



I want to set an example with the POS route. So POS, Repairs, Orders, Codes all work basically the same. They all need a customer or no customer to start with, and they all need products, parts, bicycles, and labor hours to add. I want to make a clean example of the POS, since it's the most basic module of our application, and then I want to tune up the rest, but I want to start with the POS route first. 


Well currently there are 4:
- POS
- the repairs
- the orders
- the quotes

What I want is a generalization of the customer part, a generalization of the customer section of the parts section, the labor section, and the bicycle section. 

In all the four parts, the customers are acting the same and are basically the same component. For the repairs, orders, and quotes, we have part and labor as well, and then for orders and quotes we have the bicycle as an extra one. 


Small issues

POS: 

Customers details: email and phone are not showing when available

Add Items: 

Should have labors aswell or does this need some discussion? 
In my old pos when i do a quick fix, i dont ask the name and do quick sell add some work and done. 


In my new pos i can do a quick repair, but then i need to ask the name. So i was thinking adding labors to the pos but maybe the same way our special item works, just a price and registered as labor in our system.


"providers": {
	"minimax": {
      "baseUrl": "https://api.minimax.io/v1",
      "api": "openai-completions",
      "apiKey": "sk-cp-T....",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "MiniMax-M3",
          "name": "MiniMax M3",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 65536
        }
      ]
  }}



  ### ####################################################


  1. Database 
  Reset / Seed 

  2. Input fields/variables shown for currency needs more consistancy 

  -View euro's 
  -User input euro's 
  -Database cents 
  -Suppliers data is recieved in euro's 

  3. /pos route (shop sale)
  Customer section: i want input fields for firstname, name, phone, email. Those fields also act as filters but if nothing is found we can create a new customer, this will improve my workflow

  
  4. Repair route 

    1. Add repair button + Add Repair are split over 2 lines 
    2. Intake form 
      - customer section should be the same as the one in pos 
      - Bicycle Section -> controle Db and check fields 

    3. List sortable colums and date create should be shown 
    
    4. Repair detail form  must match current styling.


  
### ########################################

Input velden valuta fixen 

euro's naar centen en centen naar euro's, of centen / euros gewoon doorspelen 


Templates van de fietsen bekijken 



### #######################################

model als input meegeven bij orchestration 

labels bekijken 

needs-triage -> need info > reviewed > ready for implementation > testen runnen > implementation reviewed


repair -> payment -> sales en  calender

orders + backorders

### #######################################