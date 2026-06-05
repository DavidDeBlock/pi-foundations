### STEP 1: Writing Prompt


General: 

1.When hovering over the icon in the sidepanel we have tooltip showing, the tooltip is needed for when the sidepanel is collapsed. 
But when hovering in open mode, the label is over the text of menu, so text on text. Can the tooltip be disabled in open mode?


2.Sales History: 

 Check the mapping of the sales table and the sales history (frontend)
 Id, date and total are not showing at all of not correctly

3.Catalog: several issues

- Clicking on the bicycle templates tab gives the following console error: 
BicycleTemplatesPage.tsx:54  GET http://192.168.0.136:5173/api/bicycle-templates 404 (Not Found)

- Clicking on the labor services tab gives the following console error: 
LaborServicesPage.tsx:55  GET http://192.168.0.136:5173/api/labor-services 404 (Not Found)

The Add New Labor Service Modal screen: 
Default Rate (€/hr) *
€ €9.00   
The Default Rate is showing 2 € signs plus i cant enter a 'free' number like 99,00 doesnt work highest i can enter is 9,99. Would be a bit to cheap.



4.Product finder after a while when searching a product using the dst tab then i get the following error: 

installHook.js:1 [Product Finder] Search failed: Search failed
api.ts:12 
 GET http://192.168.0.136:5173/api/product-finder/search?ean=8713249231600&supplier=dst 500 (Internal Server Error)

 The funny thing is the dst api checking with the green/red status checker is green and stays green, even after refresh.
 How i can i solve this problem, restart server and everything works again and no 500 on route. 

 I think it has something to do with the token refresh. 
 Plus on server reboot the status indicator of the dst tab is red, until i perform a search then it stays red, but on refresh it turns green. 
 So this is a small bug aswell 


5.We have to analyse what data when can use of the csv source of gransier, so we can show more details when clicking a product

6.We have to analyse what data when can use of the csv source of kruitbosch, so we can show more details when clicking a product


I want to create seperate issues from the following points, first lets do a Q & A about those points to make sure everything is clear

### STEP 2: skill: edit_article

** Input: written prompt file 
** Output: Structured prompt


# UI & Navigation

The sidepanel tooltip appears when hovering over the icon. This is essential for the collapsed state. However, in open mode, the tooltip label overlaps the menu text. Please disable the tooltip when the sidepanel is expanded to avoid this visual conflict.

# Sales History

Verify the data mapping between the backend sales table and the frontend Sales History view. The ID, date, and total fields are currently missing or displaying incorrect values. Ensure these core metrics render accurately in the UI.

# Catalog Management

Accessing the "Bicycle Templates" or "Labor Services" tabs triggers 404 errors for their respective API endpoints (`/api/bicycle-templates` and `/api/labor-services`). Additionally, the "Add New Labor Service" modal displays a duplicate euro symbol (€€). The input field also restricts decimal entry to `9.99`, preventing higher values like `99.00`.

# Product Finder & Suppliers

Searching via the DST tab eventually returns a 500 error, despite the status checker remaining green. Restarting the server resolves it temporarily, suggesting a token refresh issue. The status indicator also behaves inconsistently, turning red until a search is performed. Furthermore, analyze CSV data sources from GranSier and Kruitbosch to determine what additional product details can be displayed upon selection.




