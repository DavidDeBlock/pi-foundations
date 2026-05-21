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
