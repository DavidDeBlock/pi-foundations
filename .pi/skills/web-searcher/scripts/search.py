#!/usr/bin/env python3
"""
Web Searcher Tool - Serper API Integration

This script performs web searches using the Serper API and returns
structured results with title, link, and snippet.
"""

import os
import sys
import json
import urllib.request
import urllib.error
from pathlib import Path

# Use shared path constants to avoid "levels up" inconsistency bug
try:
    from paths import PROJECT_ROOT
except ImportError:
    # Fallback if paths.py not available (for standalone usage)
    PROJECT_ROOT = Path(__file__).parent.parent.parent

# Try to load .env file if python-dotenv is available
try:
    from dotenv import load_dotenv
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass  # dotenv not available, rely on environment variables

# ============================================================================
# OFFICIAL SOURCE PATTERNS (for trust scoring)
# ============================================================================
OFFICIAL_DOMAIN_PATTERNS = [
    ".gov", ".edu", ".ac.uk",
    "github.com", "python.org", "nodejs.org",
    "react.dev", "angular.io", "vuejs.org",
    "typescriptlang.org", "mdn.mozilla.org",
    "stackoverflow.com", "medium.com"
]


# ============================================================================
# ANALYSIS FUNCTIONS
# ============================================================================

def is_official_source(url: str) -> bool:
    """
    Check if URL belongs to an official/trusted source.
    
    Args:
        url: The URL to check
        
    Returns:
        True if URL matches official domain patterns
    """
    url_lower = url.lower()
    return any(pattern in url_lower for pattern in OFFICIAL_DOMAIN_PATTERNS)


def assess_source_trust(url: str) -> dict:
    """
    Assess trust level of a source URL.
    
    Args:
        url: The URL to assess
        
    Returns:
        Dictionary with trust assessment details
    """
    is_official = is_official_source(url)
    
    if is_official:
        return {
            "is_official_source": True,
            "trust_score": 0.95,
            "confidence_contribution": 0.9
        }
    else:
        # Non-official but still potentially valid source
        return {
            "is_official_source": False,
            "trust_score": 0.6,
            "confidence_contribution": 0.5
        }


def extract_topics(snippets: list[str]) -> list[str]:
    """
    Extract key topics from search result snippets.
    
    Args:
        snippets: List of snippet texts to analyze
        
    Returns:
        List of extracted topic keywords
    """
    # Simple keyword extraction - in production, could use NLP
    common_words = {"the", "and", "or", "is", "are", "was", "were",
                   "a", "an", "to", "of", "for", "on", "with", "at"}
    
    all_words = []
    for snippet in snippets:
        words = snippet.lower().split()
        filtered = [w.strip('.,;:!?)') for w in words if w.lower() not in common_words and len(w) > 2]
        all_words.extend(filtered)
    
    # Count word frequency
    word_counts = {}
    for word in all_words:
        word_counts[word] = word_counts.get(word, 0) + 1
    
    # Return top 5 most frequent words as topics
    sorted_topics = sorted(word_counts.items(), key=lambda x: x[1], reverse=True)
    return [topic for topic, count in sorted_topics[:5]]


def calculate_confidence_level(results_with_trust: list) -> str:
    """
    Calculate overall confidence level based on source trust scores.
    
    Args:
        results_with_trust: List of (result, trust_assessment) tuples
        
    Returns:
        Confidence level string: 'high', 'medium', or 'low'
    """
    if not results_with_trust:
        return "low"
    
    avg_trust = sum(t[1]["trust_score"] for t in results_with_trust) / len(results_with_trust)
    official_count = sum(1 for t in results_with_trust if t[1]["is_official_source"])
    
    if official_count >= 2 or avg_trust >= 0.8:
        return "high"
    elif official_count >= 1 or avg_trust >= 0.5:
        return "medium"
    else:
        return "low"


def generate_summary(results: list, topics: list) -> str:
    """
    Generate a brief summary of search findings.
    
    Args:
        results: List of search results
        topics: Extracted topic keywords
        
    Returns:
        Summary string
    """
    if not results:
        return "No search results found."
    
    official_count = sum(1 for r in results if is_official_source(r.get("link", "")))
    
    summary_parts = [
        f"Found {len(results)} results for the query.",
        f"Topics identified: {', '.join(topics[:3])}."
    ]
    
    if official_count > 0:
        summary_parts.append(f"{official_count} result(s) from official/trusted sources.")
    
    return " ".join(summary_parts)


def search_web(query: str, num_results: int = 5) -> dict:
    """
    Perform a web search using the Serper API with analysis.

    Args:
        query: The search query string
        num_results: Number of results to return (default: 5)

    Returns:
        Structured dictionary containing:
        - success: Boolean indicating if search succeeded
        - query: Original search query
        - results_count: Number of results found
        - results: List of result objects with analysis data
        - analysis: Analysis object with topics, confidence, summary
        - blocked_sources: List of URLs that failed to load
        - error: Error message if any (None on success)
    """
    api_key = os.environ.get("SERPER_API_KEY")
    
    if not api_key:
        return {
            "success": False,
            "query": query,
            "error": "SERPER_API_KEY environment variable not set",
            "results": [],
            "analysis": None
        }

    url = "https://google.serper.dev/search"
    
    payload = json.dumps({
        "q": query,
        "num": num_results
    })
    
    headers = {
        "X-API-KEY": api_key,
        "Content-Type": "application/json"
    }
    
    try:
        req = urllib.request.Request(url, data=payload.encode('utf-8'), headers=headers)
        
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode('utf-8'))
        
        # Extract organic search results
        organic_results = result.get("organic", [])
        
        formatted_results = []
        results_with_trust = []
        snippets_for_topics = []
        blocked_sources = []
        
        for item in organic_results[:num_results]:
            link = item.get("link", "")
            trust_assessment = assess_source_trust(link)
            
            result_entry = {
                "title": item.get("title", ""),
                "link": link,
                "snippet": item.get("snippet", ""),
                "analysis": trust_assessment
            }
            formatted_results.append(result_entry)
            results_with_trust.append((result_entry, trust_assessment))
            snippets_for_topics.append(item.get("snippet", ""))
        
        # Extract topics and calculate confidence
        topics = extract_topics(snippets_for_topics)
        confidence_level = calculate_confidence_level(results_with_trust)
        summary = generate_summary(formatted_results, topics)
        
        # Calculate average trust score
        avg_trust_score = sum(t[1]["trust_score"] for t in results_with_trust) / len(results_with_trust) if results_with_trust else 0.0
        
        return {
            "success": True,
            "query": query,
            "results_count": len(formatted_results),
            "results": formatted_results,
            "analysis": {
                "key_topics": topics,
                "summary": summary,
                "confidence_level": confidence_level,
                "source_trust_score": round(avg_trust_score, 2),
                "blocked_sources": blocked_sources
            },
            "error": None
        }
    
    except urllib.error.HTTPError as e:
        if e.code == 429:
            # Rate limited - return partial success with error info
            return {
                "success": False,
                "query": query,
                "results_count": 0,
                "results": [],
                "analysis": None,
                "blocked_sources": ["Serper API rate limit exceeded (429)"],
                "error": f"Rate limited. Wait 60 seconds before retrying."
            }
        else:
            return {
                "success": False,
                "query": query,
                "results_count": 0,
                "results": [],
                "analysis": None,
                "blocked_sources": [f"HTTP {e.code}: {e.reason}"],
                "error": f"HTTP error: {e.code} {e.reason}"
            }
    
    except urllib.error.URLError as e:
        return {
            "success": False,
            "query": query,
            "results_count": 0,
            "results": [],
            "analysis": None,
            "blocked_sources": [f"Connection error: {e.reason}"],
            "error": f"Failed to connect to Serper API: {e}"
        }
    
    except json.JSONDecodeError as e:
        return {
            "success": False,
            "query": query,
            "results_count": 0,
            "results": [],
            "analysis": None,
            "blocked_sources": ["Invalid JSON response from API"],
            "error": f"Invalid JSON response: {e}"
        }


def main():
    """Main entry point for the web searcher tool."""
    if len(sys.argv) < 2:
        print("Usage: python search.py <search_query>", file=sys.stderr)
        sys.exit(1)
    
    query = " ".join(sys.argv[1:])
    
    result = search_web(query)
    
    # Output structured results as JSON with proper encoding
    # Use stdout buffer to avoid encoding issues on Windows
    json_output = json.dumps(result, indent=2, ensure_ascii=False)
    sys.stdout.buffer.write(json_output.encode('utf-8'))
    sys.stdout.buffer.write(b'\n')


if __name__ == "__main__":
    main()
