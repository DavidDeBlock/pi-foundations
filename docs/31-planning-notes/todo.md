Question 1: The thing is that Maestro is built on several iterations where I changed my mind and did something else. Now we are at some state where I have some working parts from previous attempts, and I need to clarify.

I started out with the flow engine alone. The flow engine regulates one flow. What I could do was initiate orchestra.py with a certain flow and a certain issue, and then only that one flow ran. The whole point of this thing is to create autonomous loops. The whole point was to create certain flows and chain the flows in the layer above. Of course I need to give context through the agents. Basically, run flow should only be accepting the flow and the context. That's basically it, I think. 


Question 2: Yes, that's a good question. I should suggest that flow context is the static part, but yes, we should identify the static and dynamic parts and separate them. 


Question 3. Ok, I go with option B. 


Question 4. Let's go for option B. 

Question 5. I did some printing in the Flow runner to see what was going on and to see if everything was loaded correctly. Indeed, it messes up my interface, and it should be logged somewhere in a file instead of being shown on the screen. I need some way of logging and checking if everything is loaded correctly, so that was the reason.
What about the interface? The interface looks good, but it's maybe interesting to add some extra outputs for:
- what phases we are in currently
- how long a phase took
- how many tokens were spent
That would be some nice info to have.



Q6: Ok, option A 

Q7a: I'm not sure. I don't think so, but maybe the RPC has them. I think we need to deep dive this one. I'm not sure. 
Q7b: Okay, what you suggest is fine. 

Q8: i dunno did you check /home/david/projects/pi-foundations/.pi/maestro/lib and /home/david/projects/pi-foundations/.pi/maestro/scripts

Q9: Option A


If I can have a rich, visually looking interactive CLI tool that acts like a small program with options to choose from, and then it doesn't have to be in the same program, but maybe another CLI to just monitor everything, that would be nice. It doesn't have to be textual We don't have to use textual with panels and stuff. If we maybe the library rich, or I don't know how it's called, this is enough for our goal.