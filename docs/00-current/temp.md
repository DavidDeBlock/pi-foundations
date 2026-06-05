-front end 

-documentatie
  https://reactrouter.com/6.30.3/start/tutorial
  https://18.react.dev/learn/thinking-in-react


-rules
-layout 
-structuren 
-skill 
-flow


  baseURL = 'https://dst3-api.platformdst.nl/api/customer'
  const url = `${baseUrl}/product?eanUpc=${encodeURIComponent(ean)}&statuses=ACTIVE,OBSOLETE&page=0&size=100`

6933882568280



Host: web01.4ab.nl
Poort: 21
Protocol: FTP (SSH)

I want to create a plan for adding some extra functionality to our product finder. The way it works right now:
- We have the DST API. This API is only good for searching via Eon codes.
- I have the Kruitbosch API. That's an API to download the whole product catalog, but it's currently unavailable because my credentials are incorrect and I am waiting for new credentials.
- I have another one that's called GRANSIER, and I just received my new credentials. I want to implement it as well in our product finder.
The thing is, this is an FTP server where we manually need to download the catalogs in CSV files. I think we then have to put them somewhere and make sure they are synced every day. Let's create a plan to implement such things.
For Kruibosch and Gransier, the method is different. First, we need to download the product catalog in CSV, Excel, or whatever. Then we have to put it in our database. I think we have a table for that. When we use the product finder, then we search in our database for Kruidbos and Gransir, but DST always uses the API. 




-backend 
database updates 
database seeded 
testen met database 



-general 
e2e testen 


support-features 
-maestro 





Commercial information:
URL, ExpDelTime, PosImages, Colour, ShortDescription, LongDescription, 
LongDescriptionHTML, VideoURL


We need to change plans. The way Maestro works currently is by LLNM getting the issues. Now it is a fully automated agent system, but we should have a different look at it.

For example, if we build scripts that can do the same job, let's do the agent's work. For example, if we start up, then we can already fetch every issue. Basically, we need to take a look at our current flow and think about it in a different way, so we are actually building something that is doing the same thing deterministically and not by using agents. We can handle the comments. The only thing that the agents need to worry about is that they have certain input and certain output. That's it, and everything else is done by the script. 


Issue 113 isn't correctly implemented yet. 
There is still a problem with the column mapping mismatch on the conflict constraint error, but I know what the issue is. If you take a look at how we implemented gransier, we created a separate table for gransier, but for Kruitbosch we use Kruitbosch_supplier. In the same way, we did it for gransier. 

Adjust the issue or change the issue so the next time the agent will run it, it will properly implement or properly create the new table and map the columns. 


Let's create a plan for the following: 
I want to create detail pages for the product finder supplier tabs. When you click on a product, it opens an inline detail page of the selected product. 


