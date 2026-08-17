Hi Claude!

I have an idea for a bot I'd like to build. It's inspired by a bug on my phone, where more often than not, when I load a link to a wikipedia article, the wikipedia app loads, but the hero image it loads is from the last article I was reading. This leads to the occasional gem of juxtaposition. So what I'd like is a bluesky bot that posts a wikipedia link with the incorrect preview image.

## Concept

I think for the very first pass, it should be a single script that can run and generate a post. The post should be a wikipedia link with preview pointing to the wrong wikipedia article's image. The link should be related to one of the topics trending on bluesky, and the image could be a random wikipedia article.

## Implementation

Potential flow of script:

1. fetch list of trending topics
2. extract topics (people, places, concepts)
3. pick random topic with wikipedia article
4. pick random wikipedia article with header image
5. post on bluesky

Regarding #1, I'm not exactly sure how to fetch the list of trending topics. There doesn't appear to be an endpoint for that. Maybe we could fetch bskysuite.com/bluesky-trending-topics for now??

Regarding #2, I'm not exactly sure how to extract objects with wikipedia articles from the trending topics. Maybe we can ask another instance of Claude to do that?

## Technical Considerations

I'd like it to be written in Typescript. Since you'll be doing the actual Implementation and I'll be reviewing, it would be easiest for me if it was in a langauge I'm familiar with.

## Future Steps

Just to put some ideas down on paper, I'd like to start discussing the next steps.

- I'd like to store previous trending topics so we can closer mimic what I experience, where the last thing I looked up on wikipedia is now the juxtaposed image.

- Deploy this to Supabase
