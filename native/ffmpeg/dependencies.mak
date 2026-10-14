# Keep the dependency program in a file to avoid native Windows argument re-quoting.
override CCDEP = $(DEP$(1)) $(DEP$(1)FLAGS) $($(1)DEP_FLAGS) $< 2>&1 | awk -f ../../../dependency.awk -v target=$@ > $(@:.o=.d)
override CXXDEP = $(CCDEP)
override ASDEP = $(CCDEP)
