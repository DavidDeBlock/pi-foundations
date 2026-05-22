


Scripts: how to organize them, how to identify them, how to synthesize them, and how to extract them? 

I want to investigate what scripts we need that could help the agent. It should use less tokens, meaning less context, so it can have a bigger context size and run faster. An agent should never search and read complete files, but only use scripts so it knows in advance if I put something in, this comes out. The flow should be that the agent shouldn't read the files, but it should execute scripts so it can see trees, can see functions, can see classes, so it sees the code instead of the files. 

For example, I saw you creating a lot of scripts to extract the data from the sessions, so I think it's more handy for you. You have the scripts in place to do the work for you. We have to see it like this: you use scripts to help you, and I use you to help me. 


I know reading a file before implementation is unavoidable, but the reason why I need some scripts is to identify code flows to have an overview of how systems work. When using scripts to synthesize codebases, I think it's much easier for an agent to find his way. Let's say it like that. 


I want to make some changes to the Maestro script.



I want to make some changes to the autonomous pipeline. Currently, we have the builder review flow chained with the PRD-audit flow. 
Also, the issues that are taken by the agent are the ones with needs-triage, but that's actually wrong. We should only take the issues that are ready-for-agent. 

Some of the issues will have PRD as a parent. 
Some of the issues have not. 


Here are the following flows:

**.pi/maestro/flows/builder-reviewer.json**

**.pi/maestro/flows/prd-audit.json**. 


