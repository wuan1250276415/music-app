/including/ {
    sub(/^.*file: */, "")
    gsub(/\\/, "/")
    if (!match($0, / /)) print target ":", $0
}
